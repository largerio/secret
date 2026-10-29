import { describe, expect, it } from "vitest";
import {
	ARGON2_MAX_ITERATIONS,
	ARGON2_MAX_MEMORY_KIB,
	ARGON2_MIN_ITERATIONS,
	ARGON2_MIN_MEMORY_KIB,
	type Envelope,
	encodeEnvelope,
	FORMAT_1,
	parseEnvelope,
} from "../envelope.js";
import { testVectors } from "../test-vectors/index.js";

const streamHeader = new Uint8Array(24).map((_, i) => 0xa0 + i);
const salt = new Uint8Array(16).map((_, i) => 0xc0 + i);

const plain: Envelope = {
	streamHeader,
	fileCount: 2,
	maxReads: 1000,
	expiresIn: 2_592_000,
};

const withPassword: Envelope = {
	streamHeader,
	fileCount: 0,
	maxReads: 0,
	expiresIn: 300,
	argon2: { salt, iterations: 3, memoryKiB: 262_144 },
};

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

describe("encodeEnvelope", () => {
	it("lays an envelope out as the protocol says", () => {
		expect(hex(encodeEnvelope(plain))).toBe(
			`01 00 02 03e8 00278d00 ${hex(streamHeader)}`.replaceAll(" ", ""),
		);
	});

	it("lays a password envelope out as the protocol says", () => {
		expect(hex(encodeEnvelope(withPassword))).toBe(
			`01 01 00 0000 0000012c ${hex(streamHeader)} ${hex(salt)} 00000003 00040000`.replaceAll(
				" ",
				"",
			),
		);
	});

	it.each([
		["fileCount", { fileCount: 256 }],
		["fileCount", { fileCount: -1 }],
		["maxReads", { maxReads: 65_536 }],
		["maxReads", { maxReads: 1.5 }],
		["expiresIn", { expiresIn: 2 ** 32 }],
		["expiresIn", { expiresIn: Number.NaN }],
	])("refuses a %s that does not fit", (field, change) => {
		expect(() => encodeEnvelope({ ...plain, ...change })).toThrow(
			new RegExp(`^${field} must be an integer from 0 to \\d+$`),
		);
		expect(() => encodeEnvelope({ ...plain, ...change })).toThrow(RangeError);
	});

	it("refuses a stream header of the wrong length", () => {
		expect(() => encodeEnvelope({ ...plain, streamHeader: new Uint8Array(23) })).toThrow(
			RangeError,
		);
		expect(() => encodeEnvelope({ ...withPassword, streamHeader: new Uint8Array(25) })).toThrow(
			"The stream header must be 24 bytes",
		);
	});

	it("refuses a salt of the wrong length", () => {
		const argon2 = { salt: new Uint8Array(15), iterations: 3, memoryKiB: 262_144 };
		expect(() => encodeEnvelope({ ...withPassword, argon2 })).toThrow("The salt must be 16 bytes");
	});

	it.each([
		["iterations", ARGON2_MIN_ITERATIONS - 1, ARGON2_MIN_MEMORY_KIB],
		["iterations", ARGON2_MAX_ITERATIONS + 1, ARGON2_MIN_MEMORY_KIB],
		["memoryKiB", ARGON2_MIN_ITERATIONS, ARGON2_MIN_MEMORY_KIB - 1],
		["memoryKiB", ARGON2_MIN_ITERATIONS, ARGON2_MAX_MEMORY_KIB + 1],
	])("refuses Argon2id %s a reader would not run", (field, iterations, memoryKiB) => {
		expect(() =>
			encodeEnvelope({ ...withPassword, argon2: { salt, iterations, memoryKiB } }),
		).toThrow(`${field} must be an integer from`);
	});
});

describe("parseEnvelope", () => {
	it("reads back what encodeEnvelope wrote", () => {
		expect(parseEnvelope(encodeEnvelope(plain))).toEqual(plain);
		expect(parseEnvelope(encodeEnvelope(withPassword))).toEqual(withPassword);
	});

	it("accepts the bounds of the Argon2id parameters", () => {
		for (const [iterations, memoryKiB] of [
			[ARGON2_MIN_ITERATIONS, ARGON2_MIN_MEMORY_KIB],
			[ARGON2_MAX_ITERATIONS, ARGON2_MAX_MEMORY_KIB],
		] as const) {
			const envelope = { ...withPassword, argon2: { salt, iterations, memoryKiB } };
			expect(parseEnvelope(encodeEnvelope(envelope))).toEqual(envelope);
		}
	});

	it("reads an envelope that sits inside a larger buffer", () => {
		const bytes = encodeEnvelope(withPassword);
		const buffer = new Uint8Array(bytes.length + 7);
		buffer.set(bytes, 7);
		expect(parseEnvelope(buffer.subarray(7))).toEqual(withPassword);
	});

	it("copies the stream header and the salt out of the bytes it was given", () => {
		const bytes = encodeEnvelope(withPassword);
		const envelope = parseEnvelope(bytes);
		bytes.fill(0);
		expect(envelope).toEqual(withPassword);
	});

	const withByte = (envelope: Envelope, offset: number, value: number): Uint8Array => {
		const bytes = encodeEnvelope(envelope);
		bytes[offset] = value;
		return bytes;
	};

	const withUint32 = (offset: number, value: number): Uint8Array => {
		const bytes = encodeEnvelope(withPassword);
		new DataView(bytes.buffer).setUint32(offset, value);
		return bytes;
	};

	it.each([
		["nothing", new Uint8Array(0)],
		["a byte short", encodeEnvelope(plain).subarray(0, 32)],
		["a byte too many", new Uint8Array([...encodeEnvelope(plain), 0])],
		["a password envelope a byte short", encodeEnvelope(withPassword).subarray(0, 56)],
		["format 0 as a format byte", withByte(plain, 0, 0)],
		["format 2", withByte(plain, 0, FORMAT_1 + 1)],
		["an unknown derivation", withByte(plain, 1, 2)],
		["an envelope without a password that claims one", withByte(plain, 1, 1)],
		["a password envelope that lost its derivation byte", withByte(withPassword, 1, 0)],
		["0 iterations", withUint32(49, 0)],
		["too many iterations", withUint32(49, ARGON2_MAX_ITERATIONS + 1)],
		["too little memory", withUint32(53, ARGON2_MIN_MEMORY_KIB - 1)],
		["too much memory", withUint32(53, ARGON2_MAX_MEMORY_KIB + 1)],
	])("refuses %s", (_, bytes) => {
		expect(parseEnvelope(bytes)).toBeUndefined();
	});

	it("leaves the settings to the server's limits", () => {
		const bytes = encodeEnvelope({ ...plain, fileCount: 255, maxReads: 65_535 });
		expect(parseEnvelope(bytes)).toMatchObject({ fileCount: 255, maxReads: 65_535 });
	});
});

describe("the envelope vectors", () => {
	const b64 = (value: string) => new Uint8Array(Buffer.from(value, "base64"));

	it("encode and parse to and from the recorded bytes", () => {
		for (const v of testVectors.vectors.format1.envelopes) {
			const envelope: Envelope = {
				streamHeader: b64(v.streamHeader),
				fileCount: v.fileCount,
				maxReads: v.maxReads,
				expiresIn: v.expiresIn,
				...(v.argon2 ? { argon2: { ...v.argon2, salt: b64(v.argon2.salt) } } : {}),
			};
			expect(Buffer.from(encodeEnvelope(envelope)).toString("base64"), v.description).toBe(
				v.envelope,
			);
			expect(parseEnvelope(b64(v.envelope)), v.description).toEqual(envelope);
		}
	});

	it("parse in every note vector", () => {
		for (const v of testVectors.vectors.format1.notes) {
			expect(parseEnvelope(b64(v.envelope)), v.description).toBeDefined();
		}
	});

	it("are refused where a reader must refuse them", () => {
		for (const v of testVectors.vectors.format1.invalid.envelopes) {
			expect(parseEnvelope(b64(v.envelope)), v.description).toBeUndefined();
		}
	});
});

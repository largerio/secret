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

const nonce = new Uint8Array(24).map((_, i) => 0xa0 + i);
const salt = new Uint8Array(16).map((_, i) => 0xc0 + i);

const singleShot: Envelope = {
	kind: "single-shot",
	nonce,
	fileCount: 2,
	maxReads: 1000,
	expiresIn: 2_592_000,
};

const chunked: Envelope = {
	kind: "chunked",
	streamHeader: nonce,
	fileCount: 0,
	maxReads: 0,
	expiresIn: 300,
	argon2: { salt, iterations: 3, memoryKiB: 262_144 },
};

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

describe("encodeEnvelope", () => {
	it("lays a single-shot envelope out as the protocol says", () => {
		expect(hex(encodeEnvelope(singleShot))).toBe(
			`01 00 00 02 03e8 00278d00 ${hex(nonce)}`.replaceAll(" ", ""),
		);
	});

	it("lays a chunked password envelope out as the protocol says", () => {
		expect(hex(encodeEnvelope(chunked))).toBe(
			`01 01 01 00 0000 0000012c ${hex(nonce)} ${hex(salt)} 00000003 00040000`.replaceAll(" ", ""),
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
		expect(() => encodeEnvelope({ ...singleShot, ...change })).toThrow(
			new RangeError(`${field} does not fit in the envelope`),
		);
	});

	it("refuses a nonce or a stream header of the wrong length", () => {
		expect(() => encodeEnvelope({ ...singleShot, nonce: new Uint8Array(23) })).toThrow(RangeError);
		expect(() => encodeEnvelope({ ...chunked, streamHeader: new Uint8Array(25) })).toThrow(
			"The nonce or stream header must be 24 bytes",
		);
	});

	it("refuses a salt of the wrong length", () => {
		const argon2 = { salt: new Uint8Array(15), iterations: 3, memoryKiB: 262_144 };
		expect(() => encodeEnvelope({ ...chunked, argon2 })).toThrow("The salt must be 16 bytes");
	});

	it.each([
		["iterations", ARGON2_MIN_ITERATIONS - 1, ARGON2_MIN_MEMORY_KIB],
		["iterations", ARGON2_MAX_ITERATIONS + 1, ARGON2_MIN_MEMORY_KIB],
		["memoryKiB", ARGON2_MIN_ITERATIONS, ARGON2_MIN_MEMORY_KIB - 1],
		["memoryKiB", ARGON2_MIN_ITERATIONS, ARGON2_MAX_MEMORY_KIB + 1],
	])("refuses Argon2id %s a reader would not run", (field, iterations, memoryKiB) => {
		expect(() => encodeEnvelope({ ...chunked, argon2: { salt, iterations, memoryKiB } })).toThrow(
			`${field} does not fit in the envelope`,
		);
	});
});

describe("parseEnvelope", () => {
	it("reads back what encodeEnvelope wrote", () => {
		expect(parseEnvelope(encodeEnvelope(singleShot))).toEqual(singleShot);
		expect(parseEnvelope(encodeEnvelope(chunked))).toEqual(chunked);
	});

	it("accepts the bounds of the Argon2id parameters", () => {
		for (const [iterations, memoryKiB] of [
			[ARGON2_MIN_ITERATIONS, ARGON2_MIN_MEMORY_KIB],
			[ARGON2_MAX_ITERATIONS, ARGON2_MAX_MEMORY_KIB],
		] as const) {
			const envelope = { ...chunked, argon2: { salt, iterations, memoryKiB } };
			expect(parseEnvelope(encodeEnvelope(envelope))).toEqual(envelope);
		}
	});

	it("reads an envelope that sits inside a larger buffer", () => {
		const bytes = encodeEnvelope(chunked);
		const buffer = new Uint8Array(bytes.length + 7);
		buffer.set(bytes, 7);
		expect(parseEnvelope(buffer.subarray(7))).toEqual(chunked);
	});

	it("copies the nonce and the salt out of the bytes it was given", () => {
		const bytes = encodeEnvelope(chunked);
		const envelope = parseEnvelope(bytes);
		bytes.fill(0);
		expect(envelope).toEqual(chunked);
	});

	const withByte = (envelope: Envelope, offset: number, value: number): Uint8Array => {
		const bytes = encodeEnvelope(envelope);
		bytes[offset] = value;
		return bytes;
	};

	const withUint32 = (offset: number, value: number): Uint8Array => {
		const bytes = encodeEnvelope(chunked);
		new DataView(bytes.buffer).setUint32(offset, value);
		return bytes;
	};

	it.each([
		["nothing", new Uint8Array(0)],
		["a byte short", encodeEnvelope(singleShot).subarray(0, 33)],
		["a byte too many", new Uint8Array([...encodeEnvelope(singleShot), 0])],
		["format 0 as a format byte", withByte(singleShot, 0, 0)],
		["format 2", withByte(singleShot, 0, FORMAT_1 + 1)],
		["an unknown kind", withByte(singleShot, 1, 2)],
		["an unknown derivation", withByte(singleShot, 2, 2)],
		["a password envelope cut to the length of one without", withByte(singleShot, 2, 1)],
		["a password envelope that lost its derivation byte", withByte(chunked, 2, 0)],
		["0 iterations", withUint32(50, 0)],
		["too many iterations", withUint32(50, ARGON2_MAX_ITERATIONS + 1)],
		["too little memory", withUint32(54, ARGON2_MIN_MEMORY_KIB - 1)],
		["too much memory", withUint32(54, ARGON2_MAX_MEMORY_KIB + 1)],
	])("refuses %s", (_, bytes) => {
		expect(parseEnvelope(bytes)).toBeUndefined();
	});

	it("leaves the settings to the server's limits", () => {
		const bytes = encodeEnvelope({ ...singleShot, fileCount: 255, maxReads: 65_535 });
		expect(parseEnvelope(bytes)).toMatchObject({ fileCount: 255, maxReads: 65_535 });
	});
});

describe("the envelope vectors", () => {
	const b64 = (value: string) => new Uint8Array(Buffer.from(value, "base64"));

	it("encode and parse to and from the recorded bytes", () => {
		for (const v of testVectors.vectors.format1.envelopes) {
			const start = b64(v.nonce);
			const envelope: Envelope = {
				...(v.kind === "single-shot"
					? { kind: "single-shot", nonce: start }
					: { kind: "chunked", streamHeader: start }),
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
		const { pipeline, secretstream } = testVectors.vectors.format1;
		for (const v of pipeline) {
			expect(parseEnvelope(b64(v.envelope))?.kind, v.description).toBe("single-shot");
		}
		for (const v of secretstream) {
			expect(parseEnvelope(b64(v.envelope))?.kind, v.description).toBe("chunked");
		}
	});
});

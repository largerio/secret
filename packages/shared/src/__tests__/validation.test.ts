import { describe, expect, it } from "vitest";
import {
	MAX_EXPIRY_SECONDS,
	MAX_FILES_PER_NOTE,
	MAX_READS,
	MIN_EXPIRY_SECONDS,
	NOTE_ID_LENGTH,
} from "../constants.js";
import {
	ARGON2_DEFAULT_ITERATIONS,
	ARGON2_DEFAULT_MEMORY_KIB,
	ARGON2_MAX_ITERATIONS,
	ARGON2_MAX_MEMORY_KIB,
	ARGON2_MIN_ITERATIONS,
	ARGON2_MIN_MEMORY_KIB,
	ENVELOPE_LENGTH,
	type Envelope,
	encodeEnvelope,
} from "../envelope.js";
import {
	chunkedUploadInitFormat1Schema,
	chunkedUploadInitSchema,
	createNoteFormat1Schema,
	createNoteMultipartFormat1Schema,
	createNoteMultipartSchema,
	createNoteSchema,
	isValidNoteId,
	noteIdSchema,
	uploadSessionFormat1MetadataSchema,
	uploadSessionMetadataSchema,
} from "../validation.js";

describe("createNoteSchema", () => {
	const validRequest = {
		encryptedData: "base64encrypteddata==",
		clientNonce: "base64nonce==",
		hasPassword: false,
		expiresIn: 3600,
		maxReads: 1,
		fileCount: 0,
	};

	it("accepts a valid request", () => {
		const result = createNoteSchema.safeParse(validRequest);
		expect(result.success).toBe(true);
	});

	it("accepts maxReads of 0 (unlimited)", () => {
		const result = createNoteSchema.safeParse({ ...validRequest, maxReads: 0 });
		expect(result.success).toBe(true);
	});

	it("rejects empty encryptedData", () => {
		const result = createNoteSchema.safeParse({ ...validRequest, encryptedData: "" });
		expect(result.success).toBe(false);
	});

	it("rejects empty clientNonce", () => {
		const result = createNoteSchema.safeParse({ ...validRequest, clientNonce: "" });
		expect(result.success).toBe(false);
	});

	it("rejects expiresIn below minimum", () => {
		const result = createNoteSchema.safeParse({
			...validRequest,
			expiresIn: MIN_EXPIRY_SECONDS - 1,
		});
		expect(result.success).toBe(false);
	});

	it("rejects expiresIn above maximum", () => {
		const result = createNoteSchema.safeParse({
			...validRequest,
			expiresIn: MAX_EXPIRY_SECONDS + 1,
		});
		expect(result.success).toBe(false);
	});

	it("rejects non-integer expiresIn", () => {
		const result = createNoteSchema.safeParse({ ...validRequest, expiresIn: 3600.5 });
		expect(result.success).toBe(false);
	});

	it("rejects negative maxReads", () => {
		const result = createNoteSchema.safeParse({ ...validRequest, maxReads: -1 });
		expect(result.success).toBe(false);
	});

	it("defaults maxReads to 1 when not provided", () => {
		const { maxReads: _, ...withoutMaxReads } = validRequest;
		const result = createNoteSchema.safeParse(withoutMaxReads);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.maxReads).toBe(1);
		}
	});

	it("rejects negative fileCount", () => {
		const result = createNoteSchema.safeParse({ ...validRequest, fileCount: -1 });
		expect(result.success).toBe(false);
	});

	it("rejects fileCount above limit", () => {
		const result = createNoteSchema.safeParse({ ...validRequest, fileCount: 11 });
		expect(result.success).toBe(false);
	});

	it("accepts minimum expiresIn", () => {
		const result = createNoteSchema.safeParse({
			...validRequest,
			expiresIn: MIN_EXPIRY_SECONDS,
		});
		expect(result.success).toBe(true);
	});

	it("accepts maximum expiresIn", () => {
		const result = createNoteSchema.safeParse({
			...validRequest,
			expiresIn: MAX_EXPIRY_SECONDS,
		});
		expect(result.success).toBe(true);
	});

	it("rejects hasPassword without salt", () => {
		const result = createNoteSchema.safeParse({ ...validRequest, hasPassword: true });
		expect(result.success).toBe(false);
	});

	it("accepts hasPassword with salt", () => {
		const result = createNoteSchema.safeParse({
			...validRequest,
			hasPassword: true,
			salt: "somesalt",
		});
		expect(result.success).toBe(true);
	});

	it("accepts clientNonce at max length (48)", () => {
		const result = createNoteSchema.safeParse({ ...validRequest, clientNonce: "a".repeat(48) });
		expect(result.success).toBe(true);
	});

	it("rejects clientNonce exceeding max length", () => {
		const result = createNoteSchema.safeParse({ ...validRequest, clientNonce: "a".repeat(49) });
		expect(result.success).toBe(false);
	});

	it("rejects salt exceeding max length", () => {
		const result = createNoteSchema.safeParse({
			...validRequest,
			hasPassword: true,
			salt: "a".repeat(101),
		});
		expect(result.success).toBe(false);
	});

	it("accepts salt at max length", () => {
		const result = createNoteSchema.safeParse({
			...validRequest,
			hasPassword: true,
			salt: "a".repeat(100),
		});
		expect(result.success).toBe(true);
	});

	it("rejects maxReads above 1000", () => {
		const result = createNoteSchema.safeParse({ ...validRequest, maxReads: 1001 });
		expect(result.success).toBe(false);
	});

	it("accepts maxReads at 1000", () => {
		const result = createNoteSchema.safeParse({ ...validRequest, maxReads: 1000 });
		expect(result.success).toBe(true);
	});
});

describe("createNoteMultipartSchema", () => {
	const validMeta = {
		clientNonce: "base64nonce==",
		hasPassword: false,
		expiresIn: 3600,
		maxReads: 1,
		fileCount: 1,
	};

	it("accepts valid metadata", () => {
		const result = createNoteMultipartSchema.safeParse(validMeta);
		expect(result.success).toBe(true);
	});

	it("rejects fileCount of 0", () => {
		const result = createNoteMultipartSchema.safeParse({ ...validMeta, fileCount: 0 });
		expect(result.success).toBe(false);
	});

	it("rejects missing clientNonce", () => {
		const result = createNoteMultipartSchema.safeParse({ ...validMeta, clientNonce: "" });
		expect(result.success).toBe(false);
	});

	it("rejects hasPassword without salt", () => {
		const result = createNoteMultipartSchema.safeParse({ ...validMeta, hasPassword: true });
		expect(result.success).toBe(false);
	});

	it("accepts hasPassword with salt", () => {
		const result = createNoteMultipartSchema.safeParse({
			...validMeta,
			hasPassword: true,
			salt: "somesalt",
		});
		expect(result.success).toBe(true);
	});

	it("rejects expiresIn below minimum", () => {
		const result = createNoteMultipartSchema.safeParse({ ...validMeta, expiresIn: 1 });
		expect(result.success).toBe(false);
	});

	it("rejects expiresIn above maximum", () => {
		const result = createNoteMultipartSchema.safeParse({
			...validMeta,
			expiresIn: MAX_EXPIRY_SECONDS + 1,
		});
		expect(result.success).toBe(false);
	});

	it("accepts maxReads of 0 (unlimited)", () => {
		const result = createNoteMultipartSchema.safeParse({ ...validMeta, maxReads: 0 });
		expect(result.success).toBe(true);
	});

	it("rejects clientNonce exceeding max length", () => {
		const result = createNoteMultipartSchema.safeParse({
			...validMeta,
			clientNonce: "a".repeat(49),
		});
		expect(result.success).toBe(false);
	});
});

describe("chunkedUploadInitSchema", () => {
	const validChunked = {
		streamHeader: "someHeader",
		clientNonce: "base64nonce==",
		hasPassword: false,
		expiresIn: 3600,
		maxReads: 1,
		fileCount: 1,
		chunkCount: 5,
	};

	it("accepts a valid request without password", () => {
		const result = chunkedUploadInitSchema.safeParse(validChunked);
		expect(result.success).toBe(true);
	});

	it("rejects hasPassword=true without salt", () => {
		const result = chunkedUploadInitSchema.safeParse({ ...validChunked, hasPassword: true });
		expect(result.success).toBe(false);
		if (!result.success) {
			const saltError = result.error.issues.find((i) => i.path.includes("salt"));
			expect(saltError?.message).toBe("Salt is required when password is set");
		}
	});

	it("accepts hasPassword=true with salt", () => {
		const result = chunkedUploadInitSchema.safeParse({
			...validChunked,
			hasPassword: true,
			salt: "someSalt",
		});
		expect(result.success).toBe(true);
	});

	it("rejects streamHeader exceeding max length", () => {
		const result = chunkedUploadInitSchema.safeParse({
			...validChunked,
			streamHeader: "a".repeat(49),
		});
		expect(result.success).toBe(false);
	});

	it("accepts streamHeader at max length", () => {
		const result = chunkedUploadInitSchema.safeParse({
			...validChunked,
			streamHeader: "a".repeat(48),
		});
		expect(result.success).toBe(true);
	});

	it("rejects clientNonce exceeding max length", () => {
		const result = chunkedUploadInitSchema.safeParse({
			...validChunked,
			clientNonce: "a".repeat(49),
		});
		expect(result.success).toBe(false);
	});
});

describe("uploadSessionMetadataSchema", () => {
	const validMeta = {
		streamHeader: "someHeader",
		clientNonce: "base64nonce==",
		hasPassword: false,
		expiresIn: 3600,
		maxReads: 1,
		fileCount: 1,
	};

	it("accepts valid metadata", () => {
		const result = uploadSessionMetadataSchema.safeParse(validMeta);
		expect(result.success).toBe(true);
	});

	it("accepts metadata with salt", () => {
		const result = uploadSessionMetadataSchema.safeParse({ ...validMeta, salt: "someSalt" });
		expect(result.success).toBe(true);
	});

	it("rejects missing streamHeader", () => {
		const { streamHeader: _, ...withoutHeader } = validMeta;
		const result = uploadSessionMetadataSchema.safeParse(withoutHeader);
		expect(result.success).toBe(false);
	});

	it("rejects missing maxReads (no default in persisted metadata)", () => {
		const { maxReads: _, ...withoutMaxReads } = validMeta;
		const result = uploadSessionMetadataSchema.safeParse(withoutMaxReads);
		expect(result.success).toBe(false);
	});

	it("rejects non-object values", () => {
		expect(uploadSessionMetadataSchema.safeParse(null).success).toBe(false);
		expect(uploadSessionMetadataSchema.safeParse("string").success).toBe(false);
		expect(uploadSessionMetadataSchema.safeParse(42).success).toBe(false);
	});

	it("rejects expiresIn outside allowed range", () => {
		expect(
			uploadSessionMetadataSchema.safeParse({ ...validMeta, expiresIn: MIN_EXPIRY_SECONDS - 1 })
				.success,
		).toBe(false);
		expect(
			uploadSessionMetadataSchema.safeParse({ ...validMeta, expiresIn: MAX_EXPIRY_SECONDS + 1 })
				.success,
		).toBe(false);
	});
});

describe("isValidNoteId", () => {
	it("accepts a valid note ID", () => {
		expect(isValidNoteId("abc123def456")).toBe(true);
	});

	it("accepts URL-safe characters (hyphen, underscore)", () => {
		expect(isValidNoteId("abc_def-gh12")).toBe(true);
	});

	it("rejects an empty string", () => {
		expect(isValidNoteId("")).toBe(false);
	});

	it("rejects an ID with the wrong length", () => {
		expect(isValidNoteId("abc")).toBe(false);
		expect(isValidNoteId("a".repeat(NOTE_ID_LENGTH + 1))).toBe(false);
	});

	it("rejects special characters", () => {
		expect(isValidNoteId("abc!@#$%^&*(")).toBe(false);
	});

	it("agrees with noteIdSchema for representative inputs", () => {
		const candidates = [
			"abc123def456",
			"abc_def-gh12",
			"",
			"abc",
			"abc!@#$%^&*(",
			"a".repeat(NOTE_ID_LENGTH + 1),
		];
		for (const candidate of candidates) {
			expect(isValidNoteId(candidate)).toBe(noteIdSchema.safeParse(candidate).success);
		}
	});
});

describe("noteIdSchema", () => {
	it("accepts a valid note ID", () => {
		const result = noteIdSchema.safeParse("abc123def456");
		expect(result.success).toBe(true);
	});

	it("rejects an empty string", () => {
		const result = noteIdSchema.safeParse("");
		expect(result.success).toBe(false);
	});

	it("rejects an ID that is too short", () => {
		const result = noteIdSchema.safeParse("abc");
		expect(result.success).toBe(false);
	});

	it("rejects an ID that is too long", () => {
		const result = noteIdSchema.safeParse("a".repeat(NOTE_ID_LENGTH + 1));
		expect(result.success).toBe(false);
	});

	it("rejects special characters", () => {
		const result = noteIdSchema.safeParse("abc!@#$%^&*()");
		expect(result.success).toBe(false);
	});

	it("accepts URL-safe characters (hyphen, underscore)", () => {
		const result = noteIdSchema.safeParse("abc_def-gh12");
		expect(result.success).toBe(true);
	});
});

// --- Format 1 ---

const NONCE = new Uint8Array(24).fill(1);
const ARGON2 = {
	salt: new Uint8Array(16).fill(2),
	iterations: ARGON2_DEFAULT_ITERATIONS,
	memoryKiB: ARGON2_DEFAULT_MEMORY_KIB,
};

type Declared = Partial<Pick<Envelope, "fileCount" | "maxReads" | "expiresIn" | "argon2">>;

const DECLARED = { fileCount: 1, maxReads: 1, expiresIn: 3600 };

function singleShot(declared: Declared = {}): Uint8Array {
	return encodeEnvelope({ kind: "single-shot", nonce: NONCE, ...DECLARED, ...declared });
}

function chunked(declared: Declared = {}): Uint8Array {
	return encodeEnvelope({ kind: "chunked", streamHeader: NONCE, ...DECLARED, ...declared });
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

/** The bytes with some overwritten, at their offsets. */
function tampered(bytes: Uint8Array, changes: Record<number, number>): Uint8Array {
	const copy = bytes.slice();
	for (const [offset, value] of Object.entries(changes)) {
		copy[Number(offset)] = value;
	}
	return copy;
}

/** The bytes with a big-endian u32 overwritten at `offset`. */
function withU32(bytes: Uint8Array, offset: number, value: number): Uint8Array {
	const copy = bytes.slice();
	new DataView(copy.buffer).setUint32(offset, value);
	return copy;
}

// A password envelope's Argon2id parameters: iterations at 50, memory in KiB at 54.
const ITERATIONS = 50;
const MEMORY = 54;

describe("createNoteFormat1Schema", () => {
	const parse = (envelope: string, encryptedData = "ciphertext") =>
		createNoteFormat1Schema.safeParse({ envelope, encryptedData });

	it("hands back the envelope's bytes and what they say", () => {
		const bytes = singleShot({ fileCount: 0, maxReads: 0, expiresIn: 600 });

		const result = parse(b64(bytes));

		expect(result.success).toBe(true);
		expect(result.data?.envelope.bytes).toEqual(bytes);
		expect(result.data?.envelope.envelope).toEqual({
			kind: "single-shot",
			nonce: NONCE,
			fileCount: 0,
			maxReads: 0,
			expiresIn: 600,
		});
		expect(result.data?.encryptedData).toBe("ciphertext");
	});

	it("reads a password note's Argon2id parameters", () => {
		const result = parse(b64(singleShot({ argon2: ARGON2 })));

		expect(result.data?.envelope.envelope.argon2).toEqual(ARGON2);
	});

	it("accepts the Argon2id parameters a reader agrees to run", () => {
		for (const argon2 of [
			{ ...ARGON2, iterations: ARGON2_MIN_ITERATIONS, memoryKiB: ARGON2_MIN_MEMORY_KIB },
			{ ...ARGON2, iterations: ARGON2_MAX_ITERATIONS, memoryKiB: ARGON2_MAX_MEMORY_KIB },
		]) {
			expect(parse(b64(singleShot({ argon2 }))).success).toBe(true);
		}
	});

	it("accepts the protocol's bounds", () => {
		for (const declared of [
			{ fileCount: 0, maxReads: 0, expiresIn: MIN_EXPIRY_SECONDS },
			{ fileCount: MAX_FILES_PER_NOTE, maxReads: MAX_READS, expiresIn: MAX_EXPIRY_SECONDS },
		]) {
			expect(parse(b64(singleShot(declared))).success).toBe(true);
		}
	});

	const withPassword = singleShot({ argon2: ARGON2 });

	it.each([
		["is not base64", "not base64!"],
		["is longer than any envelope", b64(new Uint8Array(61))],
		["is shorter than any envelope", b64(singleShot().subarray(0, ENVELOPE_LENGTH - 1))],
		["is not format 1", b64(tampered(singleShot(), { 0: 0 }))],
		["has an unknown kind", b64(tampered(singleShot(), { 1: 2 }))],
		["has an unknown derivation", b64(tampered(singleShot(), { 2: 2 }))],
		["declares a password it does not carry", b64(tampered(singleShot(), { 2: 1 }))],
		["carries a password it does not declare", b64(tampered(withPassword, { 2: 0 }))],
		[
			"asks too few Argon2id iterations",
			b64(withU32(withPassword, ITERATIONS, ARGON2_MIN_ITERATIONS - 1)),
		],
		[
			"asks too many Argon2id iterations",
			b64(withU32(withPassword, ITERATIONS, ARGON2_MAX_ITERATIONS + 1)),
		],
		[
			"asks too little Argon2id memory",
			b64(withU32(withPassword, MEMORY, ARGON2_MIN_MEMORY_KIB - 1)),
		],
		[
			"asks too much Argon2id memory",
			b64(withU32(withPassword, MEMORY, ARGON2_MAX_MEMORY_KIB + 1)),
		],
		["is a chunked note's", b64(chunked())],
		["declares too many files", b64(singleShot({ fileCount: MAX_FILES_PER_NOTE + 1 }))],
		["declares too many reads", b64(singleShot({ maxReads: MAX_READS + 1 }))],
		["expires too soon", b64(singleShot({ expiresIn: MIN_EXPIRY_SECONDS - 1 }))],
		["expires too late", b64(singleShot({ expiresIn: MAX_EXPIRY_SECONDS + 1 }))],
	])("refuses an envelope that %s", (_, envelope) => {
		expect(parse(envelope).success).toBe(false);
	});

	it("names the kind of envelope it expected", () => {
		const result = parse(b64(chunked()));

		expect(result.error?.issues[0]?.message).toBe("Invalid single-shot envelope");
	});

	it("refuses an envelope without its ciphertext", () => {
		expect(parse(b64(singleShot()), "").success).toBe(false);
		expect(createNoteFormat1Schema.safeParse({ envelope: b64(singleShot()) }).success).toBe(false);
	});
});

describe("createNoteMultipartFormat1Schema", () => {
	it("accepts the envelope of a note with files", () => {
		const result = createNoteMultipartFormat1Schema.safeParse({ envelope: b64(singleShot()) });

		expect(result.data?.envelope.envelope.fileCount).toBe(1);
	});

	it("refuses the envelope of a note without files, or of a chunked note", () => {
		for (const bytes of [singleShot({ fileCount: 0 }), chunked()]) {
			const result = createNoteMultipartFormat1Schema.safeParse({ envelope: b64(bytes) });
			expect(result.success).toBe(false);
		}
	});
});

describe("chunkedUploadInitFormat1Schema", () => {
	it("accepts a chunked note's envelope, which holds its stream header", () => {
		const result = chunkedUploadInitFormat1Schema.safeParse({
			envelope: b64(chunked({ fileCount: 0 })),
			chunkCount: 3,
		});

		expect(result.data?.chunkCount).toBe(3);
		expect(result.data?.envelope.envelope).toMatchObject({
			kind: "chunked",
			streamHeader: NONCE,
			fileCount: 0,
		});
	});

	it("refuses a single-shot note's envelope", () => {
		const result = chunkedUploadInitFormat1Schema.safeParse({
			envelope: b64(singleShot()),
			chunkCount: 3,
		});

		expect(result.error?.issues[0]?.message).toBe("Invalid chunked envelope");
	});

	it("refuses a chunk count out of range, or none", () => {
		const envelope = b64(chunked());
		for (const request of [
			{ envelope, chunkCount: 0 },
			{ envelope, chunkCount: 10_001 },
			{ envelope },
		]) {
			expect(chunkedUploadInitFormat1Schema.safeParse(request).success).toBe(false);
		}
	});
});

describe("uploadSessionFormat1MetadataSchema", () => {
	it("accepts the session of a chunked note", () => {
		const bytes = chunked({ argon2: ARGON2 });

		const result = uploadSessionFormat1MetadataSchema.safeParse({ envelope: b64(bytes) });

		expect(result.data?.envelope.bytes).toEqual(bytes);
	});

	it("refuses a session whose envelope no longer holds", () => {
		for (const metadata of [{ envelope: b64(singleShot()) }, { envelope: "" }, {}, null]) {
			expect(uploadSessionFormat1MetadataSchema.safeParse(metadata).success).toBe(false);
		}
	});
});

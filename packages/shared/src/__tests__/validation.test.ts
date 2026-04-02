import { describe, expect, it } from "vitest";
import { MAX_EXPIRY_SECONDS, MIN_EXPIRY_SECONDS, NOTE_ID_LENGTH } from "../constants.js";
import {
	chunkedUploadInitSchema,
	createNoteMultipartSchema,
	createNoteSchema,
	noteIdSchema,
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

import { describe, expect, it } from "vitest";
import { createNoteSchema, noteIdSchema } from "../validation.js";
import { MAX_EXPIRY_SECONDS, MIN_EXPIRY_SECONDS } from "../constants.js";

describe("createNoteSchema", () => {
	const validRequest = {
		encryptedData: "base64encrypteddata==",
		clientNonce: "base64nonce==",
		hasPassword: false,
		burnAfterRead: true,
		expiresIn: 3600,
		fileCount: 0,
	};

	it("accepts a valid request", () => {
		const result = createNoteSchema.safeParse(validRequest);
		expect(result.success).toBe(true);
	});

	it("accepts a request with optional maxReads", () => {
		const result = createNoteSchema.safeParse({ ...validRequest, maxReads: 5 });
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

	it("rejects zero maxReads", () => {
		const result = createNoteSchema.safeParse({ ...validRequest, maxReads: 0 });
		expect(result.success).toBe(false);
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
});

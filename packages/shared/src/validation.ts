import { z } from "zod";
import {
	MAX_ENCRYPTED_DATA_SIZE,
	MAX_EXPIRY_SECONDS,
	MAX_FILES_PER_NOTE,
	MAX_NONCE_LENGTH,
	MIN_EXPIRY_SECONDS,
	NOTE_ID_LENGTH,
	UPLOAD_ID_LENGTH,
} from "./constants.js";

// Fields common to both the JSON and multipart create-note requests. The two
// differ only in how the encrypted payload is carried (inline vs multipart
// body) and in their fileCount floor, so everything else lives here.
const baseNoteFields = {
	clientNonce: z.string().min(1, "Client nonce is required").max(MAX_NONCE_LENGTH),
	hasPassword: z.boolean(),
	expiresIn: z
		.number()
		.int()
		.min(MIN_EXPIRY_SECONDS, `Minimum expiry is ${MIN_EXPIRY_SECONDS} seconds`)
		.max(MAX_EXPIRY_SECONDS, `Maximum expiry is ${MAX_EXPIRY_SECONDS} seconds`),
	maxReads: z.number().int().min(0).max(1000).default(1),
	salt: z.string().min(1).max(100).optional(),
} as const;

// Cross-field rule shared by every create-note schema: a password-protected
// note must also carry the salt used to derive its key.
const SALT_REQUIRED_REFINEMENT = {
	message: "Salt is required when password is set",
	path: ["salt"],
};
const saltMatchesPassword = (data: { hasPassword: boolean; salt?: string | undefined }): boolean =>
	!data.hasPassword || data.salt !== undefined;

export const createNoteSchema = z
	.object({
		...baseNoteFields,
		encryptedData: z.string().min(1, "Encrypted data is required").max(MAX_ENCRYPTED_DATA_SIZE),
		fileCount: z.number().int().min(0).max(MAX_FILES_PER_NOTE),
	})
	.refine(saltMatchesPassword, SALT_REQUIRED_REFINEMENT);

export const createNoteMultipartSchema = z
	.object({
		...baseNoteFields,
		fileCount: z.number().int().min(1).max(MAX_FILES_PER_NOTE),
	})
	.refine(saltMatchesPassword, SALT_REQUIRED_REFINEMENT);

const NOTE_ID_RE = /^[A-Za-z0-9_-]+$/;

export const noteIdSchema = z
	.string()
	.regex(NOTE_ID_RE, "Invalid note ID format")
	.length(NOTE_ID_LENGTH, `Note ID must be ${String(NOTE_ID_LENGTH)} characters`);

/**
 * Runtime guard for note IDs in non-OpenAPI routes (raw/stream endpoints).
 * Single source of truth for the ID format — keep in sync with noteIdSchema.
 */
export function isValidNoteId(id: string): boolean {
	return id.length === NOTE_ID_LENGTH && NOTE_ID_RE.test(id);
}

// --- Response schemas ---

export const createNoteResponseSchema = z.object({
	id: z.string(),
	expiresAt: z.string(),
	deleteToken: z.string(),
});

export const noteExistsResponseSchema = z.object({
	exists: z.literal(true),
	hasPassword: z.boolean(),
	fileCount: z.number().int(),
	expiresAt: z.string(),
	maxReads: z.number().int(),
	chunked: z.boolean(),
});

export const noteNotFoundResponseSchema = z.object({
	exists: z.literal(false),
});

export const readNoteResponseSchema = z.object({
	encryptedData: z.string(),
	clientNonce: z.string(),
	hasPassword: z.boolean(),
	fileCount: z.number().int(),
	createdAt: z.string(),
	expiresAt: z.string(),
	salt: z.string().optional(),
});

export const deleteNoteResponseSchema = z.object({
	deleted: z.literal(true),
});

export const errorResponseSchema = z.object({
	error: z.string(),
	errorId: z.string().optional(),
});

// --- Chunked upload schemas ---

/**
 * Shape of the JSON metadata persisted in an upload session row
 * (uploads.metadata column). Validated again on /complete so corrupted
 * rows surface as 500s instead of inserting malformed notes.
 */
export const uploadSessionMetadataSchema = z.object({
	streamHeader: z.string().min(1).max(MAX_NONCE_LENGTH),
	clientNonce: z.string().min(1).max(MAX_NONCE_LENGTH),
	hasPassword: z.boolean(),
	expiresIn: z.number().int().min(MIN_EXPIRY_SECONDS).max(MAX_EXPIRY_SECONDS),
	maxReads: z.number().int().min(0).max(1000),
	fileCount: z.number().int().min(0).max(MAX_FILES_PER_NOTE),
	salt: z.string().min(1).max(100).optional(),
});

export type UploadSessionMetadata = z.infer<typeof uploadSessionMetadataSchema>;

export const chunkedUploadInitSchema = uploadSessionMetadataSchema
	.extend({
		maxReads: z.number().int().min(0).max(1000).default(1),
		chunkCount: z.number().int().min(1).max(10000),
	})
	.refine((data) => !data.hasPassword || data.salt !== undefined, {
		message: "Salt is required when password is set",
		path: ["salt"],
	});

export const chunkedUploadInitResponseSchema = z.object({
	uploadId: z.string().length(UPLOAD_ID_LENGTH),
	expiresAt: z.string(),
});

export const chunkUploadResponseSchema = z.object({
	received: z.literal(true),
});

export const chunkedUploadCompleteResponseSchema = z.object({
	id: z.string(),
	expiresAt: z.string(),
	deleteToken: z.string(),
});

import { z } from "zod";
import {
	MAX_EXPIRY_SECONDS,
	MAX_FILES_PER_NOTE,
	MIN_EXPIRY_SECONDS,
	NOTE_ID_LENGTH,
} from "./constants.js";

export const createNoteSchema = z
	.object({
		encryptedData: z.string().min(1, "Encrypted data is required").max(50_000_000),
		clientNonce: z.string().min(1, "Client nonce is required").max(100),
		hasPassword: z.boolean(),
		expiresIn: z
			.number()
			.int()
			.min(MIN_EXPIRY_SECONDS, `Minimum expiry is ${MIN_EXPIRY_SECONDS} seconds`)
			.max(MAX_EXPIRY_SECONDS, `Maximum expiry is ${MAX_EXPIRY_SECONDS} seconds`),
		maxReads: z.number().int().min(0).max(1000).default(1),
		fileCount: z.number().int().min(0).max(MAX_FILES_PER_NOTE),
		salt: z.string().min(1).max(100).optional(),
	})
	.refine((data) => !data.hasPassword || data.salt !== undefined, {
		message: "Salt is required when password is set",
		path: ["salt"],
	});

export const createNoteMultipartSchema = z
	.object({
		clientNonce: z.string().min(1).max(100),
		hasPassword: z.boolean(),
		expiresIn: z
			.number()
			.int()
			.min(MIN_EXPIRY_SECONDS, `Minimum expiry is ${MIN_EXPIRY_SECONDS} seconds`)
			.max(MAX_EXPIRY_SECONDS, `Maximum expiry is ${MAX_EXPIRY_SECONDS} seconds`),
		maxReads: z.number().int().min(0).max(1000).default(1),
		fileCount: z.number().int().min(1).max(MAX_FILES_PER_NOTE),
		salt: z.string().min(1).max(100).optional(),
	})
	.refine((data) => !data.hasPassword || data.salt !== undefined, {
		message: "Salt is required when password is set",
		path: ["salt"],
	});

export const noteIdSchema = z
	.string()
	.regex(/^[A-Za-z0-9_-]+$/, "Invalid note ID format")
	.length(NOTE_ID_LENGTH, `Note ID must be ${String(NOTE_ID_LENGTH)} characters`);

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

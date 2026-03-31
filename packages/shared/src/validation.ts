import { z } from "zod";
import {
	MAX_EXPIRY_SECONDS,
	MAX_FILES_PER_NOTE,
	MIN_EXPIRY_SECONDS,
	NOTE_ID_LENGTH,
} from "./constants.js";

export const createNoteSchema = z.object({
	encryptedData: z.string().min(1, "Encrypted data is required"),
	clientNonce: z.string().min(1, "Client nonce is required"),
	hasPassword: z.boolean(),
	burnAfterRead: z.boolean(),
	expiresIn: z
		.number()
		.int()
		.min(MIN_EXPIRY_SECONDS, `Minimum expiry is ${MIN_EXPIRY_SECONDS} seconds`)
		.max(MAX_EXPIRY_SECONDS, `Maximum expiry is ${MAX_EXPIRY_SECONDS} seconds`),
	maxReads: z.number().int().positive().max(1000).optional(),
	fileCount: z.number().int().min(0).max(MAX_FILES_PER_NOTE),
	salt: z.string().min(1).optional(),
}).refine(
	(data) => !data.hasPassword || data.salt !== undefined,
	{ message: "Salt is required when password is set", path: ["salt"] },
);

export const noteIdSchema = z.string().regex(
	/^[A-Za-z0-9_-]+$/,
	"Invalid note ID format",
).length(NOTE_ID_LENGTH, `Note ID must be ${String(NOTE_ID_LENGTH)} characters`);

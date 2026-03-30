import { z } from "zod";
import {
	MAX_EXPIRY_SECONDS,
	MAX_FILES_PER_NOTE,
	MIN_EXPIRY_SECONDS,
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
	maxReads: z.number().int().positive().optional(),
	fileCount: z.number().int().min(0).max(MAX_FILES_PER_NOTE),
});

export const noteIdSchema = z.string().min(1, "Note ID is required");

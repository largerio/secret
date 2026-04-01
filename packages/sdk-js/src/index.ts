export { SecretClient } from "./client.js";
export { SecretApiError, SecretDecryptionError } from "./errors.js";
export type {
	CreateNoteOptions,
	CreateNoteResult,
	NoteInfo,
	ReadNoteOptions,
	ReadNoteResult,
	SecretClientConfig,
} from "./types.js";

export type { ContentMode, NoteFile, NotePayload } from "@secret/shared";

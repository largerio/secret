export type { ContentMode, NoteFile, NotePayload } from "@secret/shared";
export { SecretClient } from "./client.js";
export { SecretApiError, SecretDecryptionError } from "./errors.js";
export type {
	CreateNoteOptions,
	CreateNoteResult,
	DownloadPhase,
	NoteInfo,
	ProgressInfo,
	ReadNoteOptions,
	ReadNoteResult,
	SecretClientConfig,
	UploadPhase,
} from "./types.js";

import {
	DEFAULT_CHUNK_SIZE as CHUNK_SIZE,
	DEFAULT_EXPIRY_SECONDS as EXPIRY_SECONDS,
	MAX_EXPIRY_SECONDS as EXPIRY_SECONDS_MAX,
	MIN_EXPIRY_SECONDS as EXPIRY_SECONDS_MIN,
	MAX_FILES_PER_NOTE as FILES_PER_NOTE,
	NOTE_ID_LENGTH as ID_LENGTH,
	MAX_PASSWORD_ATTEMPTS as PASSWORD_ATTEMPTS,
	MAX_READS as READS,
	MAX_TEXT_SIZE as TEXT_SIZE,
} from "@largerio/secret-shared";

export { SecretClient } from "./client.js";
export {
	SecretApiError,
	type SecretApiErrorDetails,
	SecretDecryptionError,
	SecretNetworkError,
	SecretValidationError,
} from "./errors.js";
export type {
	ContentMode,
	CreateNoteOptions,
	CreateNoteResult,
	DownloadPhase,
	ExistingNoteInfo,
	FileBytes,
	NoteFile,
	NoteFileInfo,
	NoteInfo,
	NotePayload,
	ProgressInfo,
	ReadNoteIntoOptions,
	ReadNoteIntoResult,
	ReadNoteOptions,
	ReadNoteResult,
	SecretClientConfig,
	UploadPhase,
} from "./types.js";

/*
 * The protocol's limits (PROTOCOL.md), which the SDK enforces: a client can
 * check what it is given against them before calling it. An instance may set
 * lower ones, which it announces at `GET /api/v1/config`. Declared here, not
 * re-exported: the bundled declarations would point at the private package.
 */

/** The most characters (UTF-16 code units) a note's text holds. */
export const MAX_TEXT_SIZE = TEXT_SIZE;
/** The most files a note holds. */
export const MAX_FILES_PER_NOTE = FILES_PER_NOTE;
/** The most reads a note may be given; 0 means as many as it is read until it expires. */
export const MAX_READS = READS;
/** The shortest a note may live, in seconds. */
export const MIN_EXPIRY_SECONDS = EXPIRY_SECONDS_MIN;
/** The longest a note may live, in seconds. */
export const MAX_EXPIRY_SECONDS = EXPIRY_SECONDS_MAX;
/** How long a note lives when `createNote` is given no `expiresIn`, in seconds. */
export const DEFAULT_EXPIRY_SECONDS = EXPIRY_SECONDS;
/** The wrong passwords a format 1 note takes over its life: the last one deletes it. */
export const MAX_PASSWORD_ATTEMPTS = PASSWORD_ATTEMPTS;
/** An instance's chunk size, and the SDK's when `createNote` is given none, in bytes. */
export const DEFAULT_CHUNK_SIZE = CHUNK_SIZE;
/** The characters of a note's id, each of `A-Z a-z 0-9 _ -`. */
export const NOTE_ID_LENGTH = ID_LENGTH;

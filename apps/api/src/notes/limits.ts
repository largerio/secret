import { sizeClass } from "@largerio/secret-shared";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/index.js";
import { exceedsQuota } from "../quota.js";
import { NoteError } from "./errors.js";

/** The operator's limits, from the instance's configuration. */
export type NotesLimits = Pick<
	AppConfig,
	"chunkSize" | "maxChunkedFileSize" | "maxExpirySeconds" | "maxFilesPerNote" | "storageQuotaBytes"
>;

/**
 * The compiled-in schemas encode the protocol's ceilings; these are the
 * operator's own limits, which used to be advertised by `GET /api/v1/config`
 * without ever being checked.
 */
export function assertWithinLimits(
	limits: NotesLimits,
	settings: { readonly expiresIn: number; readonly fileCount: number },
): void {
	if (settings.expiresIn > limits.maxExpirySeconds) {
		throw new NoteError("expiry_above_limit", {
			message: `Maximum expiry is ${String(limits.maxExpirySeconds)} seconds`,
		});
	}
	if (settings.fileCount > limits.maxFilesPerNote) {
		throw new NoteError("too_many_files", {
			message: `Maximum ${String(limits.maxFilesPerNote)} files per note`,
		});
	}
}

/**
 * Room, in a format 1 body's head, for what is not file bytes: the text, at
 * most 102,400 characters of up to 3 bytes each, and the files' names, types
 * and sizes.
 */
const HEAD_ALLOWANCE = 512 * 1024;

/**
 * The most messages an upload session may announce: as many as files adding
 * up to `maxChunkedFileSize` take, laid out as the session's format lays them
 * (PROTOCOL.md). The limit is on the files, not on what the format adds to
 * them: a format 1 body is padded to its size class, and a format 0 note has
 * its head in a message of its own and starts each file on a new one.
 */
export function maxChunksOf(limits: NotesLimits, format: 0 | 1, fileCount: number): number {
	const messages = (bytes: number) => Math.ceil(bytes / limits.chunkSize);
	return format === 1
		? messages(sizeClass(limits.maxChunkedFileSize + HEAD_ALLOWANCE))
		: messages(limits.maxChunkedFileSize) + 1 + fileCount;
}

/** Refuses a write that would push the instance past its storage quota. */
export function assertStorageAvailable(
	db: AppDatabase,
	limits: NotesLimits,
	incomingBytes: number,
): void {
	if (exceedsQuota(db, limits.storageQuotaBytes, incomingBytes)) {
		throw new NoteError("storage_quota_exceeded");
	}
}

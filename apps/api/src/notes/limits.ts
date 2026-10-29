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

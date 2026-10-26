import { lt } from "drizzle-orm";
import { runWithConcurrency } from "./concurrency.js";
import type { AppDatabase } from "./db/index.js";
import { notes, uploads } from "./db/schema.js";
import { log } from "./logger.js";
import {
	drainPendingDeletions,
	enqueueDeletion,
	hasStoredPayload,
	runDeletion,
} from "./pendingDeletions.js";
import type { StorageBackend } from "./storage/index.js";

const CLEANUP_CONCURRENCY = 8;

/** One pass: expired notes and upload sessions, then the purges left to retry. */
export async function runCleanup(db: AppDatabase, storage: StorageBackend): Promise<void> {
	try {
		const now = new Date();

		// Each purge is queued in the transaction that deletes its row, so a
		// crash before it runs leaves a pending deletion, not an orphan.
		const expired = db.transaction((tx) => {
			const rows = tx
				.select({
					id: notes.id,
					filePath: notes.filePath,
					chunkCount: notes.chunkCount,
				})
				.from(notes)
				.where(lt(notes.expiresAt, now))
				.all();

			if (rows.length === 0) return { count: 0, deletions: [] };

			tx.delete(notes).where(lt(notes.expiresAt, now)).run();
			return {
				count: rows.length,
				deletions: rows.filter(hasStoredPayload).map((row) => enqueueDeletion(tx, row.id)),
			};
		});

		if (expired.count > 0) {
			await runWithConcurrency(expired.deletions, CLEANUP_CONCURRENCY, (deletion) =>
				runDeletion(db, storage, deletion),
			);
			log.info("expired notes deleted", { count: expired.count });
		}

		const expiredUploads = db.transaction((tx) => {
			const rows = tx
				.select({ noteId: uploads.noteId })
				.from(uploads)
				.where(lt(uploads.expiresAt, now))
				.all();

			if (rows.length === 0) return [];

			tx.delete(uploads).where(lt(uploads.expiresAt, now)).run();
			return rows.map((row) => enqueueDeletion(tx, row.noteId));
		});

		if (expiredUploads.length > 0) {
			await runWithConcurrency(expiredUploads, CLEANUP_CONCURRENCY, (deletion) =>
				runDeletion(db, storage, deletion),
			);
			log.info("expired upload sessions deleted", { count: expiredUploads.length });
		}

		const drainResult = await drainPendingDeletions(db, storage, CLEANUP_CONCURRENCY);
		if (drainResult.drained > 0 || drainResult.failed > 0) {
			log.info("pending deletions drained", {
				drained: drainResult.drained,
				failed: drainResult.failed,
			});
		}
	} catch (err: unknown) {
		log.error("cleanup job failed", { detail: Error.isError(err) ? err.message : err });
	}
}

export function startCleanupJob(
	db: AppDatabase,
	storage: StorageBackend,
	intervalMs: number,
): ReturnType<typeof setInterval> {
	return setInterval(() => {
		void runCleanup(db, storage);
	}, intervalMs);
}

import { lt } from "drizzle-orm";
import { runWithConcurrency } from "./concurrency.js";
import type { AppDatabase } from "./db/index.js";
import { notes, uploads } from "./db/schema.js";
import { log } from "./logger.js";
import { deleteOrSchedule, drainPendingDeletions } from "./pendingDeletions.js";
import type { StorageBackend } from "./storage/index.js";

const CLEANUP_CONCURRENCY = 8;

// `deleteOrSchedule` already swallows storage failures, but a failure while
// persisting the retry row (e.g. a DB error) would otherwise reject the whole
// batch and skip the remaining notes in this cycle. Isolate each task so one
// bad note never aborts cleanup of the others.
async function safeDelete(task: () => Promise<void>, noteId: string): Promise<void> {
	try {
		await task();
	} catch (err: unknown) {
		log.error("cleanup of note failed", {
			noteId,
			detail: Error.isError(err) ? err.message : err,
		});
	}
}

export function startCleanupJob(
	db: AppDatabase,
	storage: StorageBackend,
	intervalMs: number,
): ReturnType<typeof setInterval> {
	return setInterval(async () => {
		try {
			const now = new Date();

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

				if (rows.length === 0) return [];

				tx.delete(notes).where(lt(notes.expiresAt, now)).run();
				return rows;
			});

			if (expired.length > 0) {
				await runWithConcurrency(expired, CLEANUP_CONCURRENCY, (note) =>
					safeDelete(
						() =>
							deleteOrSchedule(db, storage, {
								noteId: note.id,
								filePath: note.filePath,
								chunkCount: note.chunkCount,
							}),
						note.id,
					),
				);
				log.info("expired notes deleted", { count: expired.length });
			}

			const expiredUploads = db.transaction((tx) => {
				const rows = tx
					.select({
						id: uploads.id,
						noteId: uploads.noteId,
						chunkCount: uploads.chunkCount,
					})
					.from(uploads)
					.where(lt(uploads.expiresAt, now))
					.all();

				if (rows.length === 0) return [];

				tx.delete(uploads).where(lt(uploads.expiresAt, now)).run();
				return rows;
			});

			if (expiredUploads.length > 0) {
				await runWithConcurrency(expiredUploads, CLEANUP_CONCURRENCY, (session) =>
					safeDelete(
						() =>
							deleteOrSchedule(db, storage, {
								noteId: session.noteId,
								chunkCount: session.chunkCount,
							}),
						session.noteId,
					),
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
	}, intervalMs);
}

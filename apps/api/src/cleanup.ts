import { lt } from "drizzle-orm";
import type { AppDatabase } from "./db/index.js";
import { notes, uploads } from "./db/schema.js";
import {
	drainPendingDeletions,
	runWithConcurrency,
	schedulePendingDeletion,
} from "./pendingDeletions.js";
import type { StorageBackend } from "./storage/index.js";

const CLEANUP_CONCURRENCY = 8;

export function startCleanupJob(
	db: AppDatabase,
	storage: StorageBackend,
	intervalMs: number,
): ReturnType<typeof setInterval> {
	return setInterval(async () => {
		try {
			const now = new Date();

			// Clean up expired notes
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
				await runWithConcurrency(expired, CLEANUP_CONCURRENCY, async (note) => {
					try {
						if (note.chunkCount && note.chunkCount > 0) {
							await storage.deleteChunks(note.id, note.chunkCount);
						} else if (note.filePath !== null) {
							await storage.delete(note.filePath);
						}
					} catch (err: unknown) {
						console.error(
							`[cleanup] Failed to delete storage for note ${note.id}, scheduling retry:`,
							err instanceof Error ? err.message : err,
						);
						schedulePendingDeletion(db, {
							noteId: note.id,
							filePath: note.filePath,
							chunkCount: note.chunkCount,
						});
					}
				});

				console.log(`[cleanup] ${String(expired.length)} expired notes deleted`);
			}

			// Clean up expired upload sessions
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
				await runWithConcurrency(expiredUploads, CLEANUP_CONCURRENCY, async (session) => {
					try {
						await storage.deleteChunks(session.noteId, session.chunkCount);
					} catch (err: unknown) {
						console.error(
							`[cleanup] Failed to delete chunks for upload session ${session.id}, scheduling retry:`,
							err instanceof Error ? err.message : err,
						);
						schedulePendingDeletion(db, {
							noteId: session.noteId,
							chunkCount: session.chunkCount,
						});
					}
				});

				console.log(`[cleanup] ${String(expiredUploads.length)} expired upload sessions deleted`);
			}

			// Drain any storage deletions that previously failed
			const drainResult = await drainPendingDeletions(db, storage, CLEANUP_CONCURRENCY);
			if (drainResult.drained > 0 || drainResult.failed > 0) {
				console.log(
					`[cleanup] pending deletions drained=${String(drainResult.drained)} failed=${String(drainResult.failed)}`,
				);
			}
		} catch (err: unknown) {
			console.error("[cleanup] Cleanup job failed:", err instanceof Error ? err.message : err);
		}
	}, intervalMs);
}

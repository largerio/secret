import { lt } from "drizzle-orm";
import { runWithConcurrency } from "./concurrency.js";
import type { AppDatabase } from "./db/index.js";
import { notes, uploads } from "./db/schema.js";
import { deleteOrSchedule, drainPendingDeletions } from "./pendingDeletions.js";
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
					deleteOrSchedule(db, storage, {
						noteId: note.id,
						filePath: note.filePath,
						chunkCount: note.chunkCount,
					}),
				);
				console.log(`[cleanup] ${String(expired.length)} expired notes deleted`);
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
					deleteOrSchedule(db, storage, {
						noteId: session.noteId,
						chunkCount: session.chunkCount,
					}),
				);
				console.log(`[cleanup] ${String(expiredUploads.length)} expired upload sessions deleted`);
			}

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

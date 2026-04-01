import { lt } from "drizzle-orm";
import type { AppDatabase } from "./db/index.js";
import { notes, uploads } from "./db/schema.js";
import type { StorageBackend } from "./storage/index.js";

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
				await Promise.all(
					expired.map(async (note) => {
						if (note.chunkCount && note.chunkCount > 0) {
							await storage.deleteChunks(note.id, note.chunkCount).catch((err: unknown) => {
								console.error(
									`[cleanup] Failed to delete chunks for note ${note.id}:`,
									err instanceof Error ? err.message : err,
								);
							});
						} else if (note.filePath !== null) {
							await storage.delete(note.filePath).catch((err: unknown) => {
								console.error(
									`[cleanup] Failed to delete file for note ${note.id}:`,
									err instanceof Error ? err.message : err,
								);
							});
						}
					}),
				);

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
				await Promise.all(
					expiredUploads.map((session) =>
						storage.deleteChunks(session.noteId, session.chunkCount).catch((err: unknown) => {
							console.error(
								`[cleanup] Failed to delete chunks for upload session ${session.id}:`,
								err instanceof Error ? err.message : err,
							);
						}),
					),
				);

				console.log(`[cleanup] ${String(expiredUploads.length)} expired upload sessions deleted`);
			}
		} catch (err: unknown) {
			console.error("[cleanup] Cleanup job failed:", err instanceof Error ? err.message : err);
		}
	}, intervalMs);
}

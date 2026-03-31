import { lt } from "drizzle-orm";
import type { AppDatabase } from "./db/index.js";
import { notes } from "./db/schema.js";
import type { StorageBackend } from "./storage/index.js";

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
					.select({ id: notes.id, filePath: notes.filePath })
					.from(notes)
					.where(lt(notes.expiresAt, now))
					.all();

				if (rows.length === 0) return [];

				tx.delete(notes).where(lt(notes.expiresAt, now)).run();
				return rows;
			});

			if (expired.length === 0) return;

			await Promise.all(
				expired
					.filter((note) => note.filePath !== null)
					.map((note) =>
						storage.delete(note.filePath as string).catch((err: unknown) => {
							console.error(
								`[cleanup] Failed to delete file for note ${note.id}:`,
								err instanceof Error ? err.message : err,
							);
						}),
					),
			);

			console.log(`[cleanup] ${String(expired.length)} expired notes deleted`);
		} catch (err: unknown) {
			console.error("[cleanup] Cleanup job failed:", err instanceof Error ? err.message : err);
		}
	}, intervalMs);
}

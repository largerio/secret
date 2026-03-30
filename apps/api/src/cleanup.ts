import { lt } from "drizzle-orm";
import type { AppDatabase } from "./db/index.js";
import { notes } from "./db/schema.js";
import { deleteFile } from "./storage/files.js";

export function startCleanupJob(
	db: AppDatabase,
	intervalMs: number,
): ReturnType<typeof setInterval> {
	return setInterval(() => {
		const now = new Date();
		const expired = db
			.select({ id: notes.id, filePath: notes.filePath })
			.from(notes)
			.where(lt(notes.expiresAt, now))
			.all();

		for (const note of expired) {
			if (note.filePath) {
				deleteFile(note.filePath);
			}
		}

		if (expired.length > 0) {
			db.delete(notes).where(lt(notes.expiresAt, now)).run();
			console.log(`[cleanup] ${String(expired.length)} expired notes deleted`);
		}
	}, intervalMs);
}

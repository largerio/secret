import { eq, lte } from "drizzle-orm";
import type { AppDatabase } from "./db/index.js";
import { pendingDeletions } from "./db/schema.js";
import type { StorageBackend } from "./storage/index.js";

const RETRY_BACKOFF_MS = [
	30_000, // 30s (also used for the first scheduling)
	2 * 60_000, // 2m
	10 * 60_000, // 10m
	60 * 60_000, // 1h
	6 * 60 * 60_000, // 6h
	24 * 60 * 60_000, // 24h
] as const;
const INITIAL_BACKOFF_MS: number = RETRY_BACKOFF_MS[0];
const MAX_ATTEMPTS = RETRY_BACKOFF_MS.length;

interface DeletionTarget {
	readonly noteId: string;
	readonly filePath?: string | null;
	readonly chunkCount?: number | null;
}

function isEmptyTarget(target: DeletionTarget): boolean {
	const hasChunks =
		target.chunkCount !== undefined && target.chunkCount !== null && target.chunkCount > 0;
	const hasFile = target.filePath !== undefined && target.filePath !== null;
	return !hasChunks && !hasFile;
}

export function schedulePendingDeletion(db: AppDatabase, target: DeletionTarget): void {
	if (isEmptyTarget(target)) return;
	const now = new Date();
	db.insert(pendingDeletions)
		.values({
			noteId: target.noteId,
			filePath: target.filePath ?? null,
			chunkCount: target.chunkCount ?? null,
			attempts: 0,
			nextRetryAt: new Date(now.getTime() + INITIAL_BACKOFF_MS),
			createdAt: now,
		})
		.run();
}

// Caller guarantees either chunkCount > 0 or filePath is set (enforced via
// isEmptyTarget at the entry points).
async function tryDelete(storage: StorageBackend, target: DeletionTarget): Promise<boolean> {
	try {
		if (target.chunkCount && target.chunkCount > 0) {
			await storage.deleteChunks(target.noteId, target.chunkCount);
		} else {
			await storage.delete(target.filePath as string);
		}
		return true;
	} catch {
		return false;
	}
}

// Best-effort delete with synchronous logging, falling back to a persistent
// retry queue if the storage call rejects. Routes call this after the DB has
// already removed the note row, so an unhandled failure would otherwise leak
// data on disk/S3.
export async function deleteOrSchedule(
	db: AppDatabase,
	storage: StorageBackend,
	target: DeletionTarget,
): Promise<void> {
	if (isEmptyTarget(target)) return;
	const ok = await tryDelete(storage, target);
	if (!ok) {
		console.error(`[deletions] Storage delete failed for note ${target.noteId}, scheduling retry`);
		schedulePendingDeletion(db, target);
	}
}

export async function runWithConcurrency<T>(
	items: ReadonlyArray<T>,
	limit: number,
	worker: (item: T) => Promise<void>,
): Promise<void> {
	let cursor = 0;
	const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (cursor < items.length) {
			// noUncheckedIndexedAccess gives us T | undefined here; cursor is bounded
			// by items.length so the value is always defined.
			const item = items[cursor++] as T;
			await worker(item);
		}
	});
	await Promise.all(runners);
}

export async function drainPendingDeletions(
	db: AppDatabase,
	storage: StorageBackend,
	concurrency = 8,
): Promise<{ drained: number; failed: number }> {
	const now = new Date();
	const due = db
		.select()
		.from(pendingDeletions)
		.where(lte(pendingDeletions.nextRetryAt, now))
		.all();

	if (due.length === 0) return { drained: 0, failed: 0 };

	let drained = 0;
	let failed = 0;

	await runWithConcurrency(due, concurrency, async (row) => {
		const ok = await tryDelete(storage, {
			noteId: row.noteId,
			filePath: row.filePath,
			chunkCount: row.chunkCount,
		});

		if (ok) {
			db.delete(pendingDeletions).where(eq(pendingDeletions.id, row.id)).run();
			drained++;
			return;
		}

		const nextAttempts = row.attempts + 1;
		if (nextAttempts >= MAX_ATTEMPTS) {
			console.error(
				`[deletions] Giving up on note ${row.noteId} after ${String(nextAttempts)} attempts`,
			);
			db.delete(pendingDeletions).where(eq(pendingDeletions.id, row.id)).run();
			failed++;
			return;
		}

		// nextAttempts < MAX_ATTEMPTS guarantees the index is in range.
		const backoff = RETRY_BACKOFF_MS[nextAttempts] as number;
		const nextRetryAt = new Date(Date.now() + backoff);
		db.update(pendingDeletions)
			.set({ attempts: nextAttempts, nextRetryAt })
			.where(eq(pendingDeletions.id, row.id))
			.run();
		failed++;
	});

	return { drained, failed };
}

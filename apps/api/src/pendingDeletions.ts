import { eq, lte } from "drizzle-orm";
import { runWithConcurrency } from "./concurrency.js";
import type { AppDatabase } from "./db/index.js";
import { pendingDeletions } from "./db/schema.js";
import { log } from "./logger.js";
import type { StorageBackend } from "./storage/index.js";

const RETRY_BACKOFF_MS: readonly number[] = [
	30_000, // 30s (also the initial delay before the first retry)
	2 * 60_000,
	10 * 60_000,
	60 * 60_000,
	6 * 60 * 60_000,
	24 * 60 * 60_000,
];
const INITIAL_BACKOFF_MS = RETRY_BACKOFF_MS[0] as number;
const MAX_ATTEMPTS = RETRY_BACKOFF_MS.length;
const DRAIN_BATCH_LIMIT = 1000;

/** An open `db.transaction` callback's handle. */
export type Transaction = Parameters<Parameters<AppDatabase["transaction"]>[0]>[0];

/** A purge owed for a note's stored payload, recorded in `pending_deletions`. */
export interface PendingDeletion {
	readonly id: number;
	readonly noteId: string;
}

/** Whether a note row points at a payload in storage (a file or chunks). */
export function hasStoredPayload(note: {
	filePath: string | null;
	chunkCount: number | null;
}): boolean {
	return note.filePath !== null || (note.chunkCount ?? 0) > 0;
}

/**
 * Record that a note's stored payload must go, in the transaction that lets go
 * of it: the note row or the upload session deleted. Committed together, a
 * crash before the purge leaves this row for the cleanup job rather than an
 * object nothing points to.
 *
 * The caller purges right after the commit (`runDeletion`). `delayMs` holds
 * the cleanup job off until that attempt has had time to finish.
 */
export function enqueueDeletion(
	tx: Transaction,
	noteId: string,
	delayMs = INITIAL_BACKOFF_MS,
): PendingDeletion {
	const now = Date.now();
	const row = tx
		.insert(pendingDeletions)
		.values({
			noteId,
			attempts: 0,
			nextRetryAt: new Date(now + delayMs),
			createdAt: new Date(now),
		})
		.returning({ id: pendingDeletions.id })
		.get() as { id: number };
	return { id: row.id, noteId };
}

/** Drop a deletion no longer owed: the payload it covered now belongs to a note. */
export function cancelDeletion(tx: Transaction, deletion: PendingDeletion): void {
	tx.delete(pendingDeletions).where(eq(pendingDeletions.id, deletion.id)).run();
}

/**
 * Purge now, then drop the row. Never rejects: on failure the row stays and
 * the cleanup job retries it with backoff. Logs carry the row id, never the
 * note id.
 */
export async function runDeletion(
	db: AppDatabase,
	storage: StorageBackend,
	deletion: PendingDeletion,
): Promise<void> {
	try {
		await storage.purge(deletion.noteId);
		db.delete(pendingDeletions).where(eq(pendingDeletions.id, deletion.id)).run();
	} catch (err: unknown) {
		log.error("storage purge failed, retry scheduled", {
			deletionId: deletion.id,
			detail: Error.isError(err) ? err.message : String(err),
		});
	}
}

export async function drainPendingDeletions(
	db: AppDatabase,
	storage: StorageBackend,
	concurrency = 8,
): Promise<{ drained: number; failed: number }> {
	const due = db
		.select()
		.from(pendingDeletions)
		.where(lte(pendingDeletions.nextRetryAt, new Date()))
		.limit(DRAIN_BATCH_LIMIT)
		.all();

	if (due.length === 0) return { drained: 0, failed: 0 };

	let drained = 0;
	let failed = 0;

	await runWithConcurrency(due, concurrency, async (row) => {
		try {
			await storage.purge(row.noteId);
			db.delete(pendingDeletions).where(eq(pendingDeletions.id, row.id)).run();
			drained++;
			return;
		} catch (err: unknown) {
			const detail = Error.isError(err) ? err.message : String(err);
			const nextAttempts = row.attempts + 1;

			if (nextAttempts >= MAX_ATTEMPTS) {
				// The storage sweep (reconcile.ts) picks the object up once this
				// row is gone.
				log.error("giving up on pending deletion", {
					deletionId: row.id,
					attempts: nextAttempts,
					detail,
				});
				db.delete(pendingDeletions).where(eq(pendingDeletions.id, row.id)).run();
				failed++;
				return;
			}

			const backoff = RETRY_BACKOFF_MS[nextAttempts] as number;
			db.update(pendingDeletions)
				.set({ attempts: nextAttempts, nextRetryAt: new Date(Date.now() + backoff) })
				.where(eq(pendingDeletions.id, row.id))
				.run();
			failed++;
		}
	});

	return { drained, failed };
}

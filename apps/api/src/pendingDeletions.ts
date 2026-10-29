import { eq, lte } from "drizzle-orm";
import { runWithConcurrency } from "./concurrency.js";
import type { AppDatabase, Transaction } from "./db/index.js";
import { pendingDeletions } from "./db/schema.js";
import { log } from "./logger.js";
import { describeStorageError, type StorageBackend } from "./storage/index.js";

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

/** A purge owed for a note's stored payload, recorded in `pending_deletions`. */
export interface PendingDeletion {
	readonly id: number;
	readonly noteId: string;
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

// Purge, then drop the row. Returns why it failed, worded for a log line, or
// undefined once done.
async function settle(
	db: AppDatabase,
	storage: StorageBackend,
	deletion: PendingDeletion,
): Promise<string | undefined> {
	try {
		await storage.purge(deletion.noteId);
		db.delete(pendingDeletions).where(eq(pendingDeletions.id, deletion.id)).run();
		return undefined;
	} catch (err: unknown) {
		return describeStorageError(err);
	}
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
	const failure = await settle(db, storage, deletion);
	if (failure === undefined) {
		return;
	}
	log.error("storage purge failed, retry scheduled", { deletionId: deletion.id, detail: failure });
	try {
		// The delay it was queued with only had to cover this attempt, which
		// has now failed: retry on the backoff schedule, not a day from now.
		db.update(pendingDeletions)
			.set({ nextRetryAt: new Date(Date.now() + INITIAL_BACKOFF_MS) })
			.where(eq(pendingDeletions.id, deletion.id))
			.run();
	} catch {
		// The database is failing too: the row keeps its first delay.
	}
}

/**
 * Retry the purges that are due. `failed` counts the attempts that failed
 * again, `abandoned` those of them that were the last.
 */
export async function drainPendingDeletions(
	db: AppDatabase,
	storage: StorageBackend,
	concurrency = 8,
): Promise<{ drained: number; failed: number; abandoned: number }> {
	const due = db
		.select()
		.from(pendingDeletions)
		.where(lte(pendingDeletions.nextRetryAt, new Date()))
		.limit(DRAIN_BATCH_LIMIT)
		.all();

	if (due.length === 0) return { drained: 0, failed: 0, abandoned: 0 };

	let drained = 0;
	let failed = 0;
	let abandoned = 0;

	await runWithConcurrency(due, concurrency, async (row) => {
		const failure = await settle(db, storage, row);
		if (failure === undefined) {
			drained++;
			return;
		}
		failed++;

		const attempts = row.attempts + 1;
		if (attempts >= MAX_ATTEMPTS) {
			// The storage sweep (reconcile.ts) picks the object up once this row
			// is gone.
			log.error("giving up on pending deletion", { deletionId: row.id, attempts, detail: failure });
			db.delete(pendingDeletions).where(eq(pendingDeletions.id, row.id)).run();
			abandoned++;
			return;
		}

		db.update(pendingDeletions)
			.set({ attempts, nextRetryAt: new Date(Date.now() + (RETRY_BACKOFF_MS[attempts] as number)) })
			.where(eq(pendingDeletions.id, row.id))
			.run();
	});

	return { drained, failed, abandoned };
}

import { setImmediate as nextTurn } from "node:timers/promises";
import { asc, inArray, lt } from "drizzle-orm";
import { runWithConcurrency } from "./concurrency.js";
import type { AppDatabase, Transaction } from "./db/index.js";
import { notes, uploads } from "./db/schema.js";
import { log } from "./logger.js";
import type { AppMetrics } from "./metrics.js";
import { inStorage } from "./notes/rows.js";
import {
	drainPendingDeletions,
	enqueueDeletion,
	type PendingDeletion,
	runDeletion,
} from "./pendingDeletions.js";
import { describeStorageError, type StorageBackend } from "./storage/index.js";

const CLEANUP_CONCURRENCY = 8;

/**
 * Rows deleted per transaction. A transaction holds the write lock, and the
 * event loop, until it commits: after a long outage, deleting every expired
 * note at once would stall each request until it ends.
 */
export const CLEANUP_BATCH_SIZE = 200;

interface Batch {
	readonly count: number;
	readonly deletions: readonly PendingDeletion[];
}

interface BatchOptions {
	readonly batchSize: number;
	/** The log line that reports how many rows went, once per pass. */
	readonly logAs: string;
	/** Hears of every batch that deleted rows, as soon as it commits. */
	readonly onCommit?: (count: number) => void;
}

/**
 * Run `deleteBatch` in a transaction of its own until a batch comes back
 * short. Each batch queues the purges of what it deletes in that transaction,
 * so a crash before they run leaves pending deletions, not orphans; they run
 * once it commits.
 */
async function deleteInBatches(
	db: AppDatabase,
	storage: StorageBackend,
	{ batchSize, logAs, onCommit }: BatchOptions,
	deleteBatch: (tx: Transaction) => Batch,
): Promise<void> {
	let deleted = 0;
	try {
		for (;;) {
			const batch = db.transaction(deleteBatch);
			if (batch.count > 0) {
				deleted += batch.count;
				onCommit?.(batch.count);
			}
			await runWithConcurrency(batch.deletions, CLEANUP_CONCURRENCY, (deletion) =>
				runDeletion(db, storage, deletion),
			);
			if (batch.count < batchSize) {
				return;
			}
			// A batch of inline notes awaits nothing that leaves the process: let
			// the requests queued meanwhile run before the next one.
			await nextTurn();
		}
	} finally {
		// Even when a later batch failed: the ones committed before it are gone.
		if (deleted > 0) {
			log.info(logAs, { count: deleted });
		}
	}
}

/** What the cleanup job reports to the metrics. */
export type CleanupMetrics = Pick<AppMetrics, "notesExpired" | "deletionsAbandoned">;

export interface CleanupOptions {
	readonly batchSize?: number;
	readonly metrics?: CleanupMetrics | undefined;
}

/** One pass: expired notes and upload sessions, then the purges left to retry. */
export async function runCleanup(
	db: AppDatabase,
	storage: StorageBackend,
	{ batchSize = CLEANUP_BATCH_SIZE, metrics }: CleanupOptions = {},
): Promise<void> {
	try {
		const now = new Date();

		const noteBatches: BatchOptions = {
			batchSize,
			logAs: "expired notes deleted",
			onCommit: (count) => metrics?.notesExpired(count),
		};
		await deleteInBatches(db, storage, noteBatches, (tx) => {
			const rows = tx
				.select({
					id: notes.id,
					filePath: notes.filePath,
					chunkCount: notes.chunkCount,
				})
				.from(notes)
				.where(lt(notes.expiresAt, now))
				.orderBy(asc(notes.expiresAt))
				.limit(batchSize)
				.all();

			if (rows.length === 0) return { count: 0, deletions: [] };

			const ids = rows.map((row) => row.id);
			tx.delete(notes).where(inArray(notes.id, ids)).run();
			return {
				count: rows.length,
				deletions: rows.filter(inStorage).map((row) => enqueueDeletion(tx, row.id)),
			};
		});

		const uploadBatches: BatchOptions = { batchSize, logAs: "expired upload sessions deleted" };
		await deleteInBatches(db, storage, uploadBatches, (tx) => {
			const rows = tx
				.select({ id: uploads.id, noteId: uploads.noteId })
				.from(uploads)
				.where(lt(uploads.expiresAt, now))
				.orderBy(asc(uploads.expiresAt))
				.limit(batchSize)
				.all();

			if (rows.length === 0) return { count: 0, deletions: [] };

			const ids = rows.map((row) => row.id);
			tx.delete(uploads).where(inArray(uploads.id, ids)).run();
			return {
				count: rows.length,
				deletions: rows.map((row) => enqueueDeletion(tx, row.noteId)),
			};
		});

		const drainResult = await drainPendingDeletions(db, storage, CLEANUP_CONCURRENCY);
		if (drainResult.abandoned > 0) {
			metrics?.deletionsAbandoned(drainResult.abandoned);
		}
		if (drainResult.drained > 0 || drainResult.failed > 0) {
			log.info("pending deletions drained", {
				drained: drainResult.drained,
				failed: drainResult.failed,
			});
		}
	} catch (err: unknown) {
		// Never the message: a failed query quotes its parameters, note ids
		// included.
		log.error("cleanup job failed", { detail: describeStorageError(err) });
	}
}

export function startCleanupJob(
	db: AppDatabase,
	storage: StorageBackend,
	intervalMs: number,
	metrics?: CleanupMetrics,
): ReturnType<typeof setInterval> {
	// A pass slower than the interval (a large backlog, a slow storage) would
	// otherwise start the next one on top of it, draining the same rows twice.
	let running = false;
	return setInterval(async () => {
		if (running) {
			return;
		}
		running = true;
		await runCleanup(db, storage, { metrics });
		running = false;
	}, intervalMs);
}

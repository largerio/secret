import { eq, lte } from "drizzle-orm";
import { runWithConcurrency } from "./concurrency.js";
import type { AppDatabase } from "./db/index.js";
import { pendingDeletions } from "./db/schema.js";
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

export type DeletionTarget =
	| { readonly noteId: string; readonly kind: "file"; readonly filePath: string }
	| { readonly noteId: string; readonly kind: "chunks"; readonly chunkCount: number };

interface DbDeletionShape {
	readonly noteId: string;
	readonly filePath?: string | null;
	readonly chunkCount?: number | null;
}

// Narrow a (filePath, chunkCount) DB-shaped row into the discriminated target.
// Returns undefined if the row carries no work — callers treat this as a no-op.
function toDeletionTarget(row: DbDeletionShape): DeletionTarget | undefined {
	if (row.chunkCount && row.chunkCount > 0) {
		return { noteId: row.noteId, kind: "chunks", chunkCount: row.chunkCount };
	}
	if (row.filePath) {
		return { noteId: row.noteId, kind: "file", filePath: row.filePath };
	}
	return undefined;
}

async function tryDelete(storage: StorageBackend, target: DeletionTarget): Promise<void> {
	if (target.kind === "chunks") {
		await storage.deleteChunks(target.noteId, target.chunkCount);
	} else {
		await storage.delete(target.filePath);
	}
}

function scheduleRow(db: AppDatabase, target: DeletionTarget): void {
	const now = new Date();
	db.insert(pendingDeletions)
		.values({
			noteId: target.noteId,
			filePath: target.kind === "file" ? target.filePath : null,
			chunkCount: target.kind === "chunks" ? target.chunkCount : null,
			attempts: 0,
			nextRetryAt: new Date(now.getTime() + INITIAL_BACKOFF_MS),
			createdAt: now,
		})
		.run();
}

export function schedulePendingDeletion(db: AppDatabase, row: DbDeletionShape): void {
	const target = toDeletionTarget(row);
	if (target) scheduleRow(db, target);
}

// Best-effort delete; on failure, persist a row in pending_deletions so the
// cleanup job can retry. Routes call this AFTER the note row is gone from
// the DB, so an unhandled rejection would otherwise orphan blobs on disk/S3.
export async function deleteOrSchedule(
	db: AppDatabase,
	storage: StorageBackend,
	row: DbDeletionShape,
): Promise<void> {
	const target = toDeletionTarget(row);
	if (!target) return;
	try {
		await tryDelete(storage, target);
	} catch (err: unknown) {
		const detail = Error.isError(err) ? err.message : String(err);
		console.error(
			`[deletions] Storage delete failed for note ${target.noteId}, scheduling retry: ${detail}`,
		);
		scheduleRow(db, target);
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
		const target = toDeletionTarget(row);
		if (!target) {
			db.delete(pendingDeletions).where(eq(pendingDeletions.id, row.id)).run();
			return;
		}

		try {
			await tryDelete(storage, target);
			db.delete(pendingDeletions).where(eq(pendingDeletions.id, row.id)).run();
			drained++;
			return;
		} catch (err: unknown) {
			const detail = Error.isError(err) ? err.message : String(err);
			const nextAttempts = row.attempts + 1;

			if (nextAttempts >= MAX_ATTEMPTS) {
				console.error(
					`[deletions] Giving up on note ${row.noteId} after ${String(nextAttempts)} attempts: ${detail}`,
				);
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

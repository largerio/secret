import { eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { AppDatabase } from "./db/index.js";
import { meta } from "./db/schema.js";
import { log } from "./logger.js";
import type { StorageBackend } from "./storage/index.js";

const INSTANCE_ROW = "instance_id";

/** How old an object nothing points to must be before the sweep purges it. */
export const RECONCILE_GRACE_MS = 24 * 60 * 60_000;
export const RECONCILE_FIRST_RUN_MS = 10 * 60_000;
export const RECONCILE_INTERVAL_MS = 24 * 60 * 60_000;

export type ReconcileResult =
	| { readonly status: "skipped"; readonly otherInstances: string[] }
	| {
			readonly status: "done";
			readonly scanned: number;
			readonly purged: number;
			readonly failed: number;
	  };

/**
 * This database's id, created on first use. It lives in the database and its
 * backups, so it tells the database that wrote the stored notes apart from a
 * fresh or foreign one pointed at the same storage.
 */
export function getInstanceId(db: AppDatabase): string {
	const stored = db.select().from(meta).where(eq(meta.key, INSTANCE_ROW)).get();
	if (stored !== undefined) {
		return stored.value;
	}
	const instanceId = nanoid();
	db.insert(meta).values({ key: INSTANCE_ROW, value: instanceId }).run();
	return instanceId;
}

// A note, an upload session still writing its chunks, or a queued purge (whose
// retries own the object) all keep it.
function isReferenced(db: AppDatabase, noteId: string): boolean {
	// A scalar SELECT always yields exactly one row.
	const row = db.get<{ referenced: number }>(sql`
		SELECT EXISTS (SELECT 1 FROM notes WHERE id = ${noteId})
		    OR EXISTS (SELECT 1 FROM uploads WHERE note_id = ${noteId})
		    OR EXISTS (SELECT 1 FROM pending_deletions WHERE note_id = ${noteId}) AS referenced
	`) as { referenced: number };
	return row.referenced === 1;
}

/**
 * Purge what storage holds for note ids the database no longer knows: what a
 * purge that gave up, or an earlier version, left behind.
 *
 * The database is only trusted to know every note when no other database has
 * claimed the storage. Otherwise a second instance sharing the bucket, or an
 * empty database mounted by mistake in place of the real one, would see every
 * object as an orphan.
 */
export async function reconcileStorage(
	db: AppDatabase,
	storage: StorageBackend,
	now = new Date(),
): Promise<ReconcileResult> {
	const instanceId = getInstanceId(db);
	// Claimed even when another claim is there, so that instance learns of
	// this one too; and before listing, so two first sweeps see each other.
	await storage.claim(instanceId);
	const otherInstances = (await storage.listClaims()).filter((claim) => claim !== instanceId);
	if (otherInstances.length > 0) {
		return { status: "skipped", otherInstances };
	}

	const cutoff = now.getTime() - RECONCILE_GRACE_MS;
	let scanned = 0;
	let purged = 0;
	let failed = 0;

	for await (const stored of storage.list()) {
		scanned++;
		if (stored.lastModified.getTime() > cutoff || isReferenced(db, stored.noteId)) {
			continue;
		}
		try {
			await storage.purge(stored.noteId);
			purged++;
		} catch (err: unknown) {
			failed++;
			log.error("storage sweep could not purge an orphan", {
				detail: Error.isError(err) ? err.message : String(err),
			});
		}
	}

	return { status: "done", scanned, purged, failed };
}

async function runSweep(db: AppDatabase, storage: StorageBackend): Promise<void> {
	try {
		const result = await reconcileStorage(db, storage);
		if (result.status === "skipped") {
			log.warn("storage sweep skipped: another database has claimed this storage", {
				instances: result.otherInstances,
				hint: [
					"Each instance needs its own bucket or FILES_PATH. If that database is gone",
					"for good, delete its claim (S3 key instances/<id>, or",
					"FILES_PATH/.instances/<id>) and the sweep resumes.",
				].join(" "),
			});
			return;
		}
		if (result.purged > 0 || result.failed > 0) {
			log.info("storage sweep finished", {
				scanned: result.scanned,
				purged: result.purged,
				failed: result.failed,
			});
		}
	} catch (err: unknown) {
		log.error("storage sweep failed", { detail: Error.isError(err) ? err.message : err });
	}
}

/**
 * Sweep shortly after boot, then daily. Each run is scheduled once the previous
 * one ends, so a long listing never overlaps the next.
 */
export function startReconcileJob(db: AppDatabase, storage: StorageBackend): { stop(): void } {
	let timer: ReturnType<typeof setTimeout>;
	let stopped = false;

	const schedule = (delayMs: number): void => {
		timer = setTimeout(async () => {
			await runSweep(db, storage);
			if (!stopped) {
				schedule(RECONCILE_INTERVAL_MS);
			}
		}, delayMs);
		timer.unref();
	};
	schedule(RECONCILE_FIRST_RUN_MS);

	return {
		stop() {
			stopped = true;
			clearTimeout(timer);
		},
	};
}

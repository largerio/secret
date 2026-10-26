import { inArray, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { AppDatabase } from "./db/index.js";
import { meta } from "./db/schema.js";
import { log } from "./logger.js";
import { describeStorageError, type StorageBackend } from "./storage/index.js";

const INSTANCE_ID_ROW = "instance_id";
const INSTANCE_SINCE_ROW = "instance_since";

/** How old an object nothing points to must be before the sweep purges it. */
export const RECONCILE_GRACE_MS = 24 * 60 * 60_000;
/** How long after a database first claims a storage the sweep only reports. */
export const RECONCILE_TRIAL_MS = 24 * 60 * 60_000;
export const RECONCILE_FIRST_RUN_MS = 10 * 60_000;
export const RECONCILE_INTERVAL_MS = 24 * 60 * 60_000;

export type ReconcileResult =
	| { readonly status: "skipped"; readonly otherInstances: string[] }
	| { readonly status: "trial"; readonly scanned: number; readonly orphans: number }
	| {
			readonly status: "done";
			readonly scanned: number;
			readonly purged: number;
			readonly failed: number;
	  };

/** How a scheduled sweep ended: its result, or `failed` when it threw. */
export type SweepOutcome = ReconcileResult | { readonly status: "failed" };

/**
 * This database's identity, created on first use: its id, and since when it
 * has claimed the storage. Both live in the database and its backups, so they
 * tell the database that wrote the stored notes apart from a fresh or foreign
 * one pointed at the same storage.
 */
export function getInstance(db: AppDatabase): { id: string; since: Date } {
	return db.transaction((tx) => {
		const rows = tx
			.select()
			.from(meta)
			.where(inArray(meta.key, [INSTANCE_ID_ROW, INSTANCE_SINCE_ROW]))
			.all();
		const id = rows.find((row) => row.key === INSTANCE_ID_ROW)?.value;
		const since = rows.find((row) => row.key === INSTANCE_SINCE_ROW)?.value;
		if (id !== undefined && since !== undefined) {
			return { id, since: new Date(Number(since)) };
		}

		const created = { id: nanoid(), since: new Date() };
		tx.delete(meta)
			.where(inArray(meta.key, [INSTANCE_ID_ROW, INSTANCE_SINCE_ROW]))
			.run();
		tx.insert(meta)
			.values([
				{ key: INSTANCE_ID_ROW, value: created.id },
				{ key: INSTANCE_SINCE_ROW, value: String(created.since.getTime()) },
			])
			.run();
		return created;
	});
}

/**
 * Record this database's claim on the storage. Every instance does it at boot,
 * sweeping or not, so that a sweeping neighbour on the same storage sees it and
 * stops. A failure only costs the claim until the next sweep or boot.
 */
export async function claimStorage(db: AppDatabase, storage: StorageBackend): Promise<void> {
	try {
		await storage.claim(getInstance(db).id);
	} catch (err: unknown) {
		log.warn("could not claim the storage", { detail: describeStorageError(err) });
	}
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
 * claimed the storage, and once its own claim is a day old. Otherwise a second
 * instance sharing the bucket, or an empty database mounted by mistake in place
 * of the real one, would see every object as an orphan. During that first day
 * the sweep counts what it would purge, and purges nothing.
 */
export async function reconcileStorage(
	db: AppDatabase,
	storage: StorageBackend,
	now = new Date(),
): Promise<ReconcileResult> {
	const instance = getInstance(db);
	// Claimed even when another claim is there, so that instance learns of
	// this one too; and before listing, so two first sweeps see each other.
	await storage.claim(instance.id);
	const otherInstances = (await storage.listClaims()).filter((claim) => claim !== instance.id);
	if (otherInstances.length > 0) {
		return { status: "skipped", otherInstances };
	}

	const trial = now.getTime() - instance.since.getTime() < RECONCILE_TRIAL_MS;
	const cutoff = now.getTime() - RECONCILE_GRACE_MS;
	let scanned = 0;
	let orphans = 0;
	let purged = 0;
	let failed = 0;

	for await (const stored of storage.list()) {
		scanned++;
		if (stored.lastModified.getTime() > cutoff || isReferenced(db, stored.noteId)) {
			continue;
		}
		orphans++;
		if (trial) {
			continue;
		}
		try {
			await storage.purge(stored.noteId);
			purged++;
		} catch (err: unknown) {
			failed++;
			log.error("storage sweep could not purge an orphan", {
				detail: describeStorageError(err),
			});
		}
	}

	return trial
		? { status: "trial", scanned, orphans }
		: { status: "done", scanned, purged, failed };
}

async function runSweep(
	db: AppDatabase,
	storage: StorageBackend,
	onSweep: (outcome: SweepOutcome) => void,
): Promise<void> {
	try {
		const result = await reconcileStorage(db, storage);
		onSweep(result);
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
		if (result.status === "trial") {
			if (result.orphans > 0) {
				log.warn("storage sweep on trial: nothing deleted yet", {
					scanned: result.scanned,
					orphans: result.orphans,
					hint: [
						"This database claimed the storage less than a day ago, so the sweep only",
						"counts the stored notes it does not know. If this is the wrong database",
						"(a new volume, a renamed compose project), stop the instance before the",
						"day is out: the sweep would delete them.",
					].join(" "),
				});
			}
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
		log.error("storage sweep failed", { detail: describeStorageError(err) });
		onSweep({ status: "failed" });
	}
}

/**
 * Sweep shortly after boot, then daily. Each run is scheduled once the previous
 * one ends, so a long listing never overlaps the next. `onSweep` hears how each
 * run ended (the metrics).
 */
export function startReconcileJob(
	db: AppDatabase,
	storage: StorageBackend,
	onSweep: (outcome: SweepOutcome) => void = () => {},
): { stop(): void } {
	let timer: ReturnType<typeof setTimeout>;
	let stopped = false;

	const schedule = (delayMs: number): void => {
		timer = setTimeout(async () => {
			await runSweep(db, storage, onSweep);
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

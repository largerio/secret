import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/node-sqlite";
import { applyMigrations } from "./migrations.js";

/**
 * How long a statement waits for a lock another connection holds (a backup,
 * an operator's `sqlite3` shell) before failing. node:sqlite is synchronous:
 * the wait blocks the event loop, hence the bound.
 */
export const BUSY_TIMEOUT_MS = 5_000;

/** The size the WAL is truncated back to after a checkpoint, once a burst has grown it. */
export const JOURNAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;

export function createDatabase(dbPath: string): {
	db: ReturnType<typeof drizzle>;
	sqlite: DatabaseSync;
} {
	const sqlite = new DatabaseSync(dbPath);

	sqlite.exec("PRAGMA journal_mode = WAL");
	// FULL syncs the WAL on every commit. NORMAL leaves that to checkpoints,
	// so a power cut could undo the last commits: a read that burned a note, or
	// counted towards its limit, rolled back and the note readable again.
	sqlite.exec("PRAGMA synchronous = FULL");
	sqlite.exec(`PRAGMA busy_timeout = ${String(BUSY_TIMEOUT_MS)}`);
	sqlite.exec(`PRAGMA journal_size_limit = ${String(JOURNAL_SIZE_LIMIT_BYTES)}`);
	sqlite.exec("PRAGMA foreign_keys = ON");
	sqlite.exec("PRAGMA secure_delete = ON");
	sqlite.exec("PRAGMA temp_store = MEMORY");
	sqlite.exec("PRAGMA cache_size = -8000");

	try {
		applyMigrations(sqlite);
	} catch (err) {
		sqlite.close();
		throw err;
	}

	// drizzle-orm 1.0 dropped the `schema` config option (relational queries now
	// use the separate `relations` API). This app only uses the core query
	// builder with explicit table references, so no schema/relations is needed.
	const db = drizzle({ client: sqlite });
	return { db, sqlite };
}

export type AppDatabase = ReturnType<typeof createDatabase>["db"];

/** The handle a `db.transaction` callback receives. */
export type Transaction = Parameters<Parameters<AppDatabase["transaction"]>[0]>[0];

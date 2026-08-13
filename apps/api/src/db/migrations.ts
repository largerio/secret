import type { DatabaseSync } from "node:sqlite";

/**
 * Versioned schema migrations, tracked with SQLite's `PRAGMA user_version`.
 *
 * Each migration runs in its own transaction and bumps `user_version` as part
 * of it, so a database is always in a known, numbered state — a half-applied
 * migration rolls back to the previous version. A database whose version is
 * NEWER than this build refuses to start instead of silently running an old
 * binary against a schema it does not understand.
 *
 * Workflow for schema changes:
 *   1. Edit `schema.ts` (the Drizzle source of truth).
 *   2. Run `pnpm db:generate` in `apps/api` — drizzle-kit diffs the schema
 *      against its snapshot in `apps/api/drizzle/` and writes the SQL there.
 *   3. Copy that SQL into a new entry below with the next version number.
 * The executed migrations are embedded here (not read from `.sql` files) so
 * the production image needs no extra assets and no path resolution.
 */
export interface Migration {
	readonly version: number;
	readonly name: string;
	readonly apply: (sqlite: DatabaseSync) => void;
}

/** Raised when the database was written by a newer build (downgrade attempt). */
export class DatabaseVersionError extends Error {
	readonly hint: string;

	constructor(current: number, supported: number) {
		super(
			`Database schema version ${String(current)} is newer than this build supports (${String(supported)}).`,
		);
		this.name = "DatabaseVersionError";
		this.hint =
			"This database was created by a newer version of Secret. Upgrade the application " +
			"(or restore the matching database backup); refusing to start to avoid corrupting data.";
	}
}

/** Raised when a migration fails; the transaction has been rolled back. */
export class MigrationError extends Error {
	readonly hint: string;

	constructor(migration: Migration, cause: unknown) {
		super(
			`Database migration ${String(migration.version)} (${migration.name}) failed and was rolled back.`,
			{ cause },
		);
		this.name = "MigrationError";
		this.hint = Error.isError(cause) ? cause.message : String(cause);
	}
}

function hasColumn(sqlite: DatabaseSync, table: string, column: string): boolean {
	const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
	return rows.some((row) => row.name === column);
}

// chunks_received is legacy: pre-#26 uploads stored the received chunk list
// as a JSON string here. New code uses the upload_chunks table instead, but
// the column is kept to stay compatible with databases provisioned before
// the migration. It can be dropped once all deployments have rolled over.
const BASELINE_TABLES: readonly string[] = [
	`CREATE TABLE IF NOT EXISTS notes (
		id TEXT PRIMARY KEY,
		encrypted_data BLOB NOT NULL,
		server_nonce TEXT NOT NULL,
		client_nonce TEXT NOT NULL,
		has_password INTEGER NOT NULL DEFAULT 0,
		salt TEXT,
		delete_token TEXT NOT NULL,
		burn_after_read INTEGER NOT NULL DEFAULT 0,
		file_count INTEGER NOT NULL DEFAULT 0,
		file_path TEXT,
		expires_at INTEGER NOT NULL,
		read_count INTEGER NOT NULL DEFAULT 0,
		max_reads INTEGER,
		created_at INTEGER NOT NULL,
		chunk_count INTEGER,
		stream_header TEXT
	)`,
	`CREATE TABLE IF NOT EXISTS meta (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS uploads (
		id TEXT PRIMARY KEY,
		metadata TEXT NOT NULL,
		chunk_count INTEGER NOT NULL,
		chunks_received TEXT NOT NULL DEFAULT '[]',
		note_id TEXT NOT NULL,
		delete_token TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		expires_at INTEGER NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS upload_chunks (
		upload_id TEXT NOT NULL,
		chunk_index INTEGER NOT NULL,
		PRIMARY KEY (upload_id, chunk_index),
		FOREIGN KEY (upload_id) REFERENCES uploads (id) ON DELETE CASCADE
	)`,
	`CREATE TABLE IF NOT EXISTS pending_deletions (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		note_id TEXT NOT NULL,
		file_path TEXT,
		chunk_count INTEGER,
		attempts INTEGER NOT NULL DEFAULT 0,
		next_retry_at INTEGER NOT NULL,
		created_at INTEGER NOT NULL
	)`,
];

const BASELINE_INDEXES: readonly string[] = [
	`CREATE INDEX IF NOT EXISTS idx_notes_expires_at ON notes (expires_at)`,
	`CREATE INDEX IF NOT EXISTS idx_notes_delete_token ON notes (delete_token)`,
	`CREATE INDEX IF NOT EXISTS idx_uploads_expires_at ON uploads (expires_at)`,
	`CREATE INDEX IF NOT EXISTS idx_pending_deletions_next_retry ON pending_deletions (next_retry_at)`,
];

// The baseline absorbs every pre-versioning state — empty database, legacy
// database without the chunk columns, legacy database with them — which is why
// it is idempotent (IF NOT EXISTS + column probes) where later migrations
// must not be.
const baseline: Migration = {
	version: 1,
	name: "baseline",
	apply(sqlite) {
		for (const statement of BASELINE_TABLES) {
			sqlite.exec(statement);
		}

		// Databases provisioned before chunked uploads lack these two columns
		// (CREATE TABLE IF NOT EXISTS leaves an existing table untouched).
		if (!hasColumn(sqlite, "notes", "chunk_count")) {
			sqlite.exec(`ALTER TABLE notes ADD COLUMN chunk_count INTEGER`);
		}
		if (!hasColumn(sqlite, "notes", "stream_header")) {
			sqlite.exec(`ALTER TABLE notes ADD COLUMN stream_header TEXT`);
		}

		for (const statement of BASELINE_INDEXES) {
			sqlite.exec(statement);
		}
	},
};

// Storage accounting for quotas: every stored payload records its size so the
// current usage is a SUM over two small tables (see quota.ts) instead of a
// running counter that could drift.
const storageAccounting: Migration = {
	version: 2,
	name: "storage-accounting",
	apply(sqlite) {
		sqlite.exec(`ALTER TABLE notes ADD COLUMN size_bytes INTEGER NOT NULL DEFAULT 0`);
		sqlite.exec(`ALTER TABLE upload_chunks ADD COLUMN size_bytes INTEGER NOT NULL DEFAULT 0`);

		// Backfill what can be known without touching the storage backend: inline
		// notes carry their payload in the row. Pre-existing file/chunk notes stay
		// at 0 and age out as they expire (30-day retention ceiling).
		sqlite.exec(`UPDATE notes SET size_bytes = length(encrypted_data) WHERE file_path IS NULL`);
	},
};

/** Ordered, append-only. Versions are contiguous and start at 1. */
export const MIGRATIONS: readonly Migration[] = [baseline, storageAccounting];

export function getSchemaVersion(sqlite: DatabaseSync): number {
	const row = sqlite.prepare("PRAGMA user_version").get() as { user_version: number };
	return row.user_version;
}

export function applyMigrations(
	sqlite: DatabaseSync,
	migrations: readonly Migration[] = MIGRATIONS,
): void {
	const latest = (migrations[migrations.length - 1] as Migration).version;
	const current = getSchemaVersion(sqlite);

	if (current > latest) {
		throw new DatabaseVersionError(current, latest);
	}

	for (const migration of migrations) {
		if (migration.version <= current) {
			continue;
		}

		sqlite.exec("BEGIN IMMEDIATE");
		try {
			migration.apply(sqlite);
			sqlite.exec(`PRAGMA user_version = ${String(migration.version)}`);
			sqlite.exec("COMMIT");
		} catch (err) {
			sqlite.exec("ROLLBACK");
			throw new MigrationError(migration, err);
		}
	}
}

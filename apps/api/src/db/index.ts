import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/node-sqlite";

export function createDatabase(dbPath: string): {
	db: ReturnType<typeof drizzle>;
	sqlite: DatabaseSync;
} {
	const sqlite = new DatabaseSync(dbPath);

	sqlite.exec("PRAGMA journal_mode = WAL");
	sqlite.exec("PRAGMA synchronous = NORMAL");
	sqlite.exec("PRAGMA foreign_keys = ON");
	sqlite.exec("PRAGMA secure_delete = ON");
	sqlite.exec("PRAGMA temp_store = MEMORY");
	sqlite.exec("PRAGMA cache_size = -8000");

	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS notes (
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
			created_at INTEGER NOT NULL
		)
	`);

	// Add chunk columns to existing notes table (no-op if already present)
	try {
		sqlite.exec(`ALTER TABLE notes ADD COLUMN chunk_count INTEGER`);
	} catch {
		/* column already exists */
	}
	try {
		sqlite.exec(`ALTER TABLE notes ADD COLUMN stream_header TEXT`);
	} catch {
		/* column already exists */
	}

	// chunks_received is legacy: pre-#26 uploads stored the received chunk list
	// as a JSON string here. New code uses the upload_chunks table instead, but
	// the column is kept to stay compatible with databases provisioned before
	// the migration. It can be dropped once all deployments have rolled over.
	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS meta (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		)
	`);

	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS uploads (
			id TEXT PRIMARY KEY,
			metadata TEXT NOT NULL,
			chunk_count INTEGER NOT NULL,
			chunks_received TEXT NOT NULL DEFAULT '[]',
			note_id TEXT NOT NULL,
			delete_token TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL
		)
	`);

	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS upload_chunks (
			upload_id TEXT NOT NULL,
			chunk_index INTEGER NOT NULL,
			PRIMARY KEY (upload_id, chunk_index),
			FOREIGN KEY (upload_id) REFERENCES uploads (id) ON DELETE CASCADE
		)
	`);

	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS pending_deletions (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			note_id TEXT NOT NULL,
			file_path TEXT,
			chunk_count INTEGER,
			attempts INTEGER NOT NULL DEFAULT 0,
			next_retry_at INTEGER NOT NULL,
			created_at INTEGER NOT NULL
		)
	`);

	sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_notes_expires_at ON notes (expires_at)`);
	sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_notes_delete_token ON notes (delete_token)`);
	sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_uploads_expires_at ON uploads (expires_at)`);
	sqlite.exec(
		`CREATE INDEX IF NOT EXISTS idx_pending_deletions_next_retry ON pending_deletions (next_retry_at)`,
	);

	// drizzle-orm 1.0 dropped the `schema` config option (relational queries now
	// use the separate `relations` API). This app only uses the core query
	// builder with explicit table references, so no schema/relations is needed.
	const db = drizzle({ client: sqlite });
	return { db, sqlite };
}

export type AppDatabase = ReturnType<typeof createDatabase>["db"];

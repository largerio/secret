import type BetterSqlite3 from "better-sqlite3";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

export function createDatabase(dbPath: string): {
	db: ReturnType<typeof drizzle>;
	sqlite: BetterSqlite3.Database;
} {
	const sqlite = new Database(dbPath);

	sqlite.pragma("journal_mode = WAL");
	sqlite.pragma("synchronous = NORMAL");
	sqlite.pragma("foreign_keys = ON");
	sqlite.pragma("secure_delete = ON");
	sqlite.pragma("temp_store = MEMORY");
	sqlite.pragma("cache_size = -8000");

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

	sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_notes_expires_at ON notes (expires_at)`);
	sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_notes_delete_token ON notes (delete_token)`);
	sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_uploads_expires_at ON uploads (expires_at)`);

	const db = drizzle(sqlite, { schema });
	return { db, sqlite };
}

export type AppDatabase = ReturnType<typeof createDatabase>["db"];

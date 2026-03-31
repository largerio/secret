import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

export function createDatabase(dbPath: string) {
	const sqlite = new Database(dbPath);

	sqlite.pragma("journal_mode = WAL");
	sqlite.pragma("synchronous = FULL");
	sqlite.pragma("foreign_keys = ON");
	sqlite.pragma("secure_delete = ON");
	sqlite.pragma("temp_store = MEMORY");

	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS notes (
			id TEXT PRIMARY KEY,
			encrypted_data BLOB NOT NULL,
			server_nonce TEXT NOT NULL,
			client_nonce TEXT NOT NULL,
			has_password INTEGER NOT NULL DEFAULT 0,
			salt TEXT,
			delete_token TEXT NOT NULL DEFAULT '',
			burn_after_read INTEGER NOT NULL DEFAULT 0,
			file_count INTEGER NOT NULL DEFAULT 0,
			file_path TEXT,
			expires_at INTEGER NOT NULL,
			read_count INTEGER NOT NULL DEFAULT 0,
			max_reads INTEGER,
			created_at INTEGER NOT NULL
		)
	`);

	sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_notes_expires_at ON notes (expires_at)`);

	const db = drizzle(sqlite, { schema });
	return { db, sqlite };
}

export type AppDatabase = ReturnType<typeof createDatabase>["db"];

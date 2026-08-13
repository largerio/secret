import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/node-sqlite";
import { applyMigrations } from "./migrations.js";

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

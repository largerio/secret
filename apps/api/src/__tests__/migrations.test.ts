import { mkdirSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "../db/index.js";
import {
	applyMigrations,
	DatabaseVersionError,
	getSchemaVersion,
	MIGRATIONS,
	type Migration,
	MigrationError,
} from "../db/migrations.js";

const TEST_DB_PATH = "./data/test-migrations.db";
const LATEST = (MIGRATIONS[MIGRATIONS.length - 1] as Migration).version;

function removeTestDb(): void {
	rmSync(TEST_DB_PATH, { force: true });
	rmSync(`${TEST_DB_PATH}-wal`, { force: true });
	rmSync(`${TEST_DB_PATH}-shm`, { force: true });
}

function columnNames(sqlite: DatabaseSync, table: string): string[] {
	const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
	return rows.map((row) => row.name);
}

function tableNames(sqlite: DatabaseSync): string[] {
	const rows = sqlite
		.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
		.all() as Array<{ name: string }>;
	return rows.map((row) => row.name);
}

function indexNames(sqlite: DatabaseSync): string[] {
	const rows = sqlite
		.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'`)
		.all() as Array<{ name: string }>;
	return rows.map((row) => row.name).sort();
}

/** The pre-versioning schema: no chunk columns, no user_version. */
function provisionLegacyDatabase(): void {
	const sqlite = new DatabaseSync(TEST_DB_PATH);
	sqlite.exec(`
		CREATE TABLE notes (
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
	sqlite
		.prepare(
			`INSERT INTO notes (id, encrypted_data, server_nonce, client_nonce, delete_token, file_path, expires_at, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run("legacy-note-1", Buffer.from("blob"), "iv", "nonce", "token", null, 9999999999999, 1);
	sqlite
		.prepare(
			`INSERT INTO notes (id, encrypted_data, server_nonce, client_nonce, delete_token, file_path, expires_at, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run("legacy-note-2", Buffer.alloc(0), "iv", "nonce", "token", "files/x", 9999999999999, 1);
	sqlite.close();
}

beforeAll(() => {
	mkdirSync("./data", { recursive: true });
});

beforeEach(() => {
	removeTestDb();
});

afterAll(() => {
	removeTestDb();
});

describe("applyMigrations", () => {
	it("brings a fresh database to the latest version with the full schema", () => {
		const { sqlite } = createDatabase(TEST_DB_PATH);

		expect(getSchemaVersion(sqlite)).toBe(LATEST);
		expect(tableNames(sqlite)).toEqual(
			expect.arrayContaining(["notes", "meta", "uploads", "upload_chunks", "pending_deletions"]),
		);
		expect(columnNames(sqlite, "notes")).toEqual(
			expect.arrayContaining(["chunk_count", "stream_header", "size_bytes"]),
		);
		expect(columnNames(sqlite, "upload_chunks")).toContain("size_bytes");
		expect(indexNames(sqlite)).toEqual([
			"idx_notes_delete_token",
			"idx_notes_expires_at",
			"idx_pending_deletions_next_retry",
			"idx_uploads_expires_at",
		]);
		sqlite.close();
	});

	it("baselines a legacy database: adds chunk columns, keeps rows, stamps the version", () => {
		provisionLegacyDatabase();

		const { sqlite } = createDatabase(TEST_DB_PATH);

		expect(getSchemaVersion(sqlite)).toBe(LATEST);
		expect(columnNames(sqlite, "notes")).toEqual(
			expect.arrayContaining(["chunk_count", "stream_header"]),
		);
		const row = sqlite.prepare(`SELECT id FROM notes WHERE id = 'legacy-note-1'`).get() as {
			id: string;
		};
		expect(row.id).toBe("legacy-note-1");
		sqlite.close();
	});

	it("backfills size_bytes for inline notes only (file sizes are unknowable offline)", () => {
		provisionLegacyDatabase();

		const { sqlite } = createDatabase(TEST_DB_PATH);

		const sizes = sqlite.prepare(`SELECT id, size_bytes FROM notes ORDER BY id`).all() as Array<{
			id: string;
			size_bytes: number;
		}>;
		expect(sizes).toEqual([
			{ id: "legacy-note-1", size_bytes: 4 },
			{ id: "legacy-note-2", size_bytes: 0 },
		]);
		sqlite.close();
	});

	it("is a no-op on an already-migrated database", () => {
		createDatabase(TEST_DB_PATH).sqlite.close();

		const { sqlite } = createDatabase(TEST_DB_PATH);
		expect(getSchemaVersion(sqlite)).toBe(LATEST);
		sqlite.close();
	});

	it("refuses to open a database written by a newer build", () => {
		const sqlite = new DatabaseSync(TEST_DB_PATH);
		sqlite.exec("PRAGMA user_version = 999");
		sqlite.close();

		expect(() => createDatabase(TEST_DB_PATH)).toThrow(DatabaseVersionError);
		try {
			createDatabase(TEST_DB_PATH);
		} catch (err) {
			const versionError = err as DatabaseVersionError;
			expect(versionError.message).toContain("999");
			expect(versionError.message).toContain(`newer than this build supports (${String(LATEST)})`);
			expect(versionError.hint).toContain("newer version of Secret");
		}
	});

	it("rolls back a failed migration and reports it with its cause", () => {
		const { sqlite } = createDatabase(TEST_DB_PATH);

		const broken: Migration = {
			version: LATEST + 1,
			name: "broken",
			apply(database) {
				database.exec("CREATE TABLE partial (id INTEGER)");
				throw new Error("disk exploded");
			},
		};

		expect(() => applyMigrations(sqlite, [...MIGRATIONS, broken])).toThrow(MigrationError);
		try {
			applyMigrations(sqlite, [...MIGRATIONS, broken]);
		} catch (err) {
			const migrationError = err as MigrationError;
			expect(migrationError.message).toBe(
				`Database migration ${String(LATEST + 1)} (broken) failed and was rolled back.`,
			);
			expect(migrationError.hint).toBe("disk exploded");
		}

		expect(getSchemaVersion(sqlite)).toBe(LATEST);
		expect(tableNames(sqlite)).not.toContain("partial");
		sqlite.close();
	});

	it("stringifies a non-Error migration failure in the hint", () => {
		const { sqlite } = createDatabase(TEST_DB_PATH);

		const broken: Migration = {
			version: LATEST + 1,
			name: "broken-string",
			apply() {
				throw "string failure";
			},
		};

		try {
			applyMigrations(sqlite, [...MIGRATIONS, broken]);
			expect.unreachable("applyMigrations should have thrown");
		} catch (err) {
			expect((err as MigrationError).hint).toBe("string failure");
		}
		sqlite.close();
	});

	it("applies a pending migration on an up-to-date database", () => {
		const { sqlite } = createDatabase(TEST_DB_PATH);

		const addTable: Migration = {
			version: LATEST + 1,
			name: "add-table",
			apply(database) {
				database.exec("CREATE TABLE extra (id INTEGER PRIMARY KEY)");
			},
		};

		applyMigrations(sqlite, [...MIGRATIONS, addTable]);

		expect(getSchemaVersion(sqlite)).toBe(LATEST + 1);
		expect(tableNames(sqlite)).toContain("extra");
		sqlite.close();
	});
});

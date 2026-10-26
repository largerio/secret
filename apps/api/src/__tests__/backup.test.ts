import { randomBytes } from "node:crypto";
import { once } from "node:events";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backupDatabase, runBackupCommand, verifyBackup } from "../db/backup.js";
import { type AppDatabase, createDatabase } from "../db/index.js";
import { getSchemaVersion, MIGRATIONS, type Migration } from "../db/migrations.js";
import { meta, notes } from "../db/schema.js";
import { assertServerKeyMatches } from "../keyGuard.js";
import { getInstance } from "../reconcile.js";

// Fails the rename that puts the copy in place, on cue.
const renameFailure = vi.hoisted(() => ({ armed: false }));
vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	return {
		...fs,
		renameSync: (...args: Parameters<typeof fs.renameSync>) => {
			if (renameFailure.armed) {
				throw new Error("EXDEV: cross-device link not permitted");
			}
			fs.renameSync(...args);
		},
	};
});

const DIR = "./data/backup-test";
const SOURCE = `${DIR}/secret.db`;
const DESTINATION = `${DIR}/backup.db`;
const LATEST = (MIGRATIONS[MIGRATIONS.length - 1] as Migration).version;

const connections: DatabaseSync[] = [];

/** The live database, as the API opens it. */
function openSource(): { db: AppDatabase; sqlite: DatabaseSync } {
	const opened = createDatabase(SOURCE);
	connections.push(opened.sqlite);
	return opened;
}

function openCopy(path = DESTINATION): DatabaseSync {
	const sqlite = new DatabaseSync(path, { readOnly: true });
	connections.push(sqlite);
	return sqlite;
}

function insertNote(db: AppDatabase, id: string, data = Buffer.from("ciphertext")): void {
	db.insert(notes)
		.values({
			id,
			encryptedData: data,
			serverNonce: "iv",
			clientNonce: "nonce",
			deleteToken: "token",
			expiresAt: new Date(Date.now() + 3_600_000),
			createdAt: new Date(),
		})
		.run();
}

function noteIds(sqlite: DatabaseSync): unknown[] {
	return sqlite
		.prepare("SELECT id FROM notes ORDER BY id")
		.all()
		.map((row) => row["id"]);
}

function schemaOf(sqlite: DatabaseSync): unknown[] {
	return sqlite.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name").all();
}

beforeEach(() => {
	rmSync(DIR, { recursive: true, force: true });
	mkdirSync(DIR, { recursive: true });
});

afterEach(() => {
	for (const sqlite of connections.splice(0)) {
		if (sqlite.isOpen) {
			sqlite.close();
		}
	}
	renameFailure.armed = false;
	vi.restoreAllMocks();
});

afterAll(() => {
	rmSync(DIR, { recursive: true, force: true });
});

// Another connection, in a thread of its own, committing as fast as it can
// until told to stop. Each transaction adds a row to `writes` and records the
// count in `meta`: a consistent copy has both agree.
const WRITER = `
const { DatabaseSync } = require("node:sqlite");
const { parentPort, workerData } = require("node:worker_threads");
const state = new Int32Array(workerData.state);
const db = new DatabaseSync(workerData.path);
db.exec("PRAGMA busy_timeout = 5000");
const insert = db.prepare("INSERT INTO writes (n) VALUES (?)");
const mark = db.prepare(
	"INSERT INTO meta (key, value) VALUES ('writes', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
);
let n = 0;
while (Atomics.load(state, 1) === 0) {
	n++;
	db.exec("BEGIN IMMEDIATE");
	insert.run(n);
	mark.run(String(n));
	db.exec("COMMIT");
	Atomics.store(state, 0, n);
}
db.close();
parentPort.postMessage(n);
`;

describe("backupDatabase", () => {
	it("copies a database the API holds open, commits still in the WAL included", () => {
		const { db, sqlite } = openSource();
		sqlite.exec("PRAGMA wal_autocheckpoint = 0");
		insertNote(db, "inwal0000001");
		insertNote(db, "inwal0000002");
		expect(statSync(`${SOURCE}-wal`).size).toBeGreaterThan(0);

		const result = backupDatabase(SOURCE, DESTINATION);

		expect(result).toEqual({
			source: resolve(SOURCE),
			destination: resolve(DESTINATION),
			schemaVersion: LATEST,
			bytes: statSync(DESTINATION).size,
		});
		expect(noteIds(openCopy())).toEqual(["inwal0000001", "inwal0000002"]);
		// A single file, with no WAL of its own to carry along.
		expect(readdirSync(DIR).filter((name) => name.startsWith("backup"))).toEqual(["backup.db"]);
	});

	it("leaves no WAL files behind with the app stopped", () => {
		const { db, sqlite } = openSource();
		insertNote(db, "stopped00001");
		sqlite.close();
		expect(readdirSync(DIR)).toEqual(["secret.db"]);

		backupDatabase(SOURCE, DESTINATION);

		// Left behind by a run as another user (root), they would stop the app
		// from opening its database.
		expect(readdirSync(DIR).sort()).toEqual(["backup.db", "secret.db"]);
		expect(noteIds(openCopy())).toEqual(["stopped00001"]);
	});

	it("makes a copy the API starts on as it was: schema, version, identity, server key", () => {
		const { db, sqlite } = openSource();
		const identity = getInstance(db);
		assertServerKeyMatches(db, randomBytes(32));
		insertNote(db, "restored0001");

		backupDatabase(SOURCE, DESTINATION);

		const restored = createDatabase(DESTINATION);
		connections.push(restored.sqlite);
		expect(getSchemaVersion(restored.sqlite)).toBe(LATEST);
		expect(schemaOf(restored.sqlite)).toEqual(schemaOf(sqlite));
		// The storage sweep tells this database apart from a foreign one by it.
		expect(getInstance(restored.db)).toEqual(identity);
		expect(restored.db.select().from(meta).all()).toEqual(db.select().from(meta).all());
		expect(noteIds(restored.sqlite)).toEqual(["restored0001"]);
	});

	it("carries nothing deleted, even what a connection without secure_delete left behind", () => {
		const { db } = openSource();
		const burned = Buffer.from("ciphertext-of-a-burned-note-".repeat(8));
		insertNote(db, "burned000001", burned);
		insertNote(db, "kept00000001");
		// An operator's sqlite3 shell: secure_delete is off unless it sets it.
		const shell = new DatabaseSync(SOURCE);
		connections.push(shell);
		shell.exec("PRAGMA secure_delete = OFF");
		shell.prepare("DELETE FROM notes WHERE id = ?").run("burned000001");
		shell.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		expect(readFileSync(SOURCE).includes(burned)).toBe(true);

		backupDatabase(SOURCE, DESTINATION);

		expect(readFileSync(DESTINATION).includes(burned)).toBe(false);
		expect(noteIds(openCopy())).toEqual(["kept00000001"]);
	});

	it("takes one consistent snapshot while another connection keeps writing", async () => {
		const { sqlite } = openSource();
		sqlite.exec("CREATE TABLE writes (n INTEGER PRIMARY KEY)");
		sqlite.exec("CREATE TABLE filler (data BLOB)");
		// Enough data for the copy to take a while.
		const fill = sqlite.prepare("INSERT INTO filler (data) VALUES (?)");
		sqlite.exec("BEGIN");
		for (let i = 0; i < 4000; i++) {
			fill.run(randomBytes(8192));
		}
		sqlite.exec("COMMIT");

		const state = new Int32Array(new SharedArrayBuffer(8));
		const writer = new Worker(WRITER, {
			eval: true,
			workerData: { path: SOURCE, state: state.buffer },
		});
		const stopped = once(writer, "message");
		await vi.waitFor(() => expect(Atomics.load(state, 0)).toBeGreaterThan(10), {
			timeout: 10_000,
		});

		const before = Atomics.load(state, 0);
		backupDatabase(SOURCE, DESTINATION);
		const after = Atomics.load(state, 0);
		Atomics.store(state, 1, 1);
		await stopped;

		// The writer was never blocked by the copy...
		expect(after).toBeGreaterThan(before);
		// ...which holds every write up to one moment, and the count that goes
		// with them.
		const copy = openCopy();
		const copied = Number(copy.prepare("SELECT count(*) AS n FROM writes").get()?.["n"]);
		const counted = Number(
			copy.prepare("SELECT value FROM meta WHERE key = 'writes'").get()?.["value"],
		);
		expect(copied).toBe(counted);
		expect(copied).toBeGreaterThanOrEqual(before);
		expect(copied).toBeLessThanOrEqual(after);
	}, 30_000);

	it("never overwrites an existing file", () => {
		openSource();
		writeFileSync(DESTINATION, "yesterday's backup");

		expect(() => backupDatabase(SOURCE, DESTINATION)).toThrow(
			`${resolve(DESTINATION)} already exists: a backup never overwrites a file.`,
		);
		expect(readFileSync(DESTINATION, "utf8")).toBe("yesterday's backup");
	});

	it("refuses a missing database rather than create an empty one", () => {
		expect(() => backupDatabase(`${DIR}/missing.db`, DESTINATION)).toThrow(
			`No database at ${resolve(DIR, "missing.db")}: set DATABASE_PATH to the API's database.`,
		);
		expect(readdirSync(DIR)).toEqual([]);
	});

	it("refuses a destination in a directory that does not exist", () => {
		openSource();

		expect(() => backupDatabase(SOURCE, `${DIR}/missing/backup.db`)).toThrow(
			`No directory ${resolve(DIR, "missing")} to write the backup in.`,
		);
	});

	it("leaves nothing behind when the copy fails", () => {
		writeFileSync(SOURCE, "not a database ".repeat(100));

		expect(() => backupDatabase(SOURCE, DESTINATION)).toThrow("file is not a database");
		expect(readdirSync(DIR)).toEqual(["secret.db"]);
	});

	it("removes the finished copy when it cannot be put in place", () => {
		openSource();
		renameFailure.armed = true;

		expect(() => backupDatabase(SOURCE, DESTINATION)).toThrow("EXDEV");
		expect(readdirSync(DIR).filter((name) => name.startsWith("backup"))).toEqual([]);
	});
});

describe("verifyBackup", () => {
	it("returns the schema version of a sound copy", () => {
		openSource();
		backupDatabase(SOURCE, DESTINATION);

		expect(verifyBackup(DESTINATION)).toBe(LATEST);
	});

	it("rejects a copy that fails SQLite's integrity check", () => {
		const path = `${DIR}/corrupt.db`;
		const corrupt = new DatabaseSync(path);
		corrupt.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v BLOB)");
		const insert = corrupt.prepare("INSERT INTO t VALUES (?, ?)");
		for (let i = 0; i < 200; i++) {
			insert.run(i, Buffer.alloc(100, i));
		}
		const pageSize = Number(corrupt.prepare("PRAGMA page_size").get()?.["page_size"]);
		corrupt.close();
		// Point the first free block of the table's root page past its end.
		const fd = openSync(path, "r+");
		writeSync(fd, Buffer.from([0x0f, 0xff]), 0, 2, pageSize + 1);
		closeSync(fd);

		expect(() => verifyBackup(path)).toThrow(/integrity check: .*free space corruption/s);
	});
});

describe("runBackupCommand", () => {
	it("backs up the database at DATABASE_PATH and says where to", () => {
		openSource();
		const out = vi.spyOn(console, "log").mockImplementation(() => {});

		expect(runBackupCommand([DESTINATION], { DATABASE_PATH: SOURCE })).toBe(0);

		expect(out).toHaveBeenCalledWith(
			`Backed up ${resolve(SOURCE)} to ${resolve(DESTINATION)} (schema version ${String(LATEST)}, ${String(statSync(DESTINATION).size)} bytes).`,
		);
	});

	it("reports a failure and exits with 1", () => {
		openSource();
		writeFileSync(DESTINATION, "");
		const err = vi.spyOn(console, "error").mockImplementation(() => {});

		expect(runBackupCommand([DESTINATION], { DATABASE_PATH: SOURCE })).toBe(1);

		expect(err).toHaveBeenCalledWith(
			`Backup failed: ${resolve(DESTINATION)} already exists: a backup never overwrites a file.`,
		);
	});

	it("looks for the database where the API does without DATABASE_PATH", () => {
		const out = vi.spyOn(console, "log").mockImplementation(() => {});
		const err = vi.spyOn(console, "error").mockImplementation(() => {});

		runBackupCommand([DESTINATION], {});

		// Found or not, the path is the API's default.
		const printed = [...out.mock.calls, ...err.mock.calls].flat().join("\n");
		expect(printed).toContain(resolve("./data/secret.db"));
	});

	it("prints the usage and exits with 2 unless given one destination", () => {
		const err = vi.spyOn(console, "error").mockImplementation(() => {});

		expect(runBackupCommand([], {})).toBe(2);
		expect(runBackupCommand(["a.db", "b.db"], {})).toBe(2);
		expect(runBackupCommand(["--force"], {})).toBe(2);

		expect(err).toHaveBeenCalledTimes(3);
		expect(err).toHaveBeenCalledWith(
			expect.stringContaining("Usage: node apps/api/dist/backup.js <destination>"),
		);
		expect(existsSync("a.db")).toBe(false);
	});

	it("prints the usage on --help", () => {
		const out = vi.spyOn(console, "log").mockImplementation(() => {});

		expect(runBackupCommand(["--help"], {})).toBe(0);
		expect(runBackupCommand(["-h"], {})).toBe(0);

		expect(out).toHaveBeenCalledTimes(2);
		expect(out).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
	});
});

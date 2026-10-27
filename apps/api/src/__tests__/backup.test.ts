import { randomBytes } from "node:crypto";
import { once } from "node:events";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	rmSync,
	statSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../config.js";
import { backupDatabase, runBackupCommand, verifyBackup } from "../db/backup.js";
import { type AppDatabase, createDatabase } from "../db/index.js";
import { getSchemaVersion, MIGRATIONS, type Migration } from "../db/migrations.js";
import { meta, notes } from "../db/schema.js";
import { assertServerKeyMatches } from "../keyGuard.js";
import { getInstance } from "../reconcile.js";

// Watches the fsyncs and renames of a backup: `calls` records them in order,
// `onSync` runs before a file is synced, and the rename fails while
// `renameFails` is set.
const fsHooks = vi.hoisted(() => ({
	paths: new Map<number, string>(),
	calls: [] as string[][],
	onSync: undefined as ((path: string) => void) | undefined,
	renameFails: false,
}));
vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	return {
		...fs,
		openSync: (...args: Parameters<typeof fs.openSync>) => {
			const fd = fs.openSync(...args);
			fsHooks.paths.set(fd, String(args[0]));
			return fd;
		},
		fsyncSync: (fd: number) => {
			const path = fsHooks.paths.get(fd) ?? "";
			fsHooks.calls.push(["fsync", path]);
			fsHooks.onSync?.(path);
			fs.fsyncSync(fd);
		},
		renameSync: (...args: Parameters<typeof fs.renameSync>) => {
			fsHooks.calls.push(["rename", String(args[0]), String(args[1])]);
			if (fsHooks.renameFails) {
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

function backupFiles(): string[] {
	return readdirSync(DIR).filter((name) => name.startsWith("backup"));
}

/** Points the first free block of page 2, the first table's root, past the page's end. */
function corrupt(path: string): void {
	const fd = openSync(path, "r+");
	try {
		const header = Buffer.alloc(100);
		readSync(fd, header, 0, header.length, 0);
		const pageSize = header.readUInt16BE(16);
		writeSync(fd, Buffer.from([0x0f, 0xff]), 0, 2, pageSize + 1);
	} finally {
		closeSync(fd);
	}
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
	fsHooks.calls.length = 0;
	fsHooks.onSync = undefined;
	fsHooks.renameFails = false;
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
		expect(backupFiles()).toEqual(["backup.db"]);
	});

	it("makes a copy only its owner can read: it holds the deletion tokens", () => {
		openSource();

		backupDatabase(SOURCE, DESTINATION);

		expect(statSync(DESTINATION).mode & 0o777).toBe(0o600);
	});

	it("syncs the copy before putting it in place, and the directory after", () => {
		openSource();

		backupDatabase(SOURCE, DESTINATION);

		const partial = expect.stringMatching(/\/backup\.db\.[0-9a-f]{8}\.partial$/);
		expect(fsHooks.calls).toEqual([
			["fsync", partial],
			["rename", partial, resolve(DESTINATION)],
			["fsync", resolve(DIR)],
		]);
	});

	it("checks the copy as synced, before putting it in place", () => {
		openSource();
		// Damaged on its way to the disk.
		fsHooks.onSync = (path) => {
			if (path.endsWith(".partial")) {
				corrupt(path);
			}
		};

		expect(() => backupDatabase(SOURCE, DESTINATION)).toThrow(/integrity check/);
		expect(backupFiles()).toEqual([]);
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
		// The writer's count right before and right after VACUUM INTO: the sync
		// and the check that follow would let a writer it blocked catch up.
		const vacuum = { before: 0, after: 0 };
		const run = StatementSync.prototype.run;
		vi.spyOn(StatementSync.prototype, "run").mockImplementation(function (
			this: StatementSync,
			...params: Parameters<StatementSync["run"]>
		) {
			if (this.sourceSQL !== "VACUUM INTO ?") {
				return run.apply(this, params);
			}
			vacuum.before = Atomics.load(state, 0);
			const result = run.apply(this, params);
			vacuum.after = Atomics.load(state, 0);
			return result;
		});

		try {
			await vi.waitFor(() => expect(Atomics.load(state, 0)).toBeGreaterThan(10), {
				timeout: 10_000,
			});
			backupDatabase(SOURCE, DESTINATION);
		} finally {
			Atomics.store(state, 1, 1);
			await stopped;
		}

		// The writer kept committing while VACUUM INTO ran, beyond the commit it
		// may have had in flight as the copy began...
		expect(vacuum.after - vacuum.before).toBeGreaterThan(1);
		// ...which holds every write up to one moment, and the count that goes
		// with them.
		const copy = openCopy();
		const copied = Number(copy.prepare("SELECT count(*) AS n FROM writes").get()?.["n"]);
		const counted = Number(
			copy.prepare("SELECT value FROM meta WHERE key = 'writes'").get()?.["value"],
		);
		expect(copied).toBe(counted);
		expect(copied).toBeGreaterThanOrEqual(vacuum.before);
		expect(copied).toBeLessThanOrEqual(vacuum.after);
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

	it("removes the journal a failed copy leaves", () => {
		openSource();
		// A VACUUM INTO that fills the disk fails and leaves its journal behind:
		// the same, one step later.
		fsHooks.onSync = (path) => {
			if (path.endsWith(".partial")) {
				writeFileSync(`${path}-journal`, "");
				throw new Error("database or disk is full");
			}
		};

		expect(() => backupDatabase(SOURCE, DESTINATION)).toThrow("database or disk is full");
		expect(backupFiles()).toEqual([]);
	});

	it("removes the finished copy when it cannot be put in place", () => {
		openSource();
		fsHooks.renameFails = true;

		expect(() => backupDatabase(SOURCE, DESTINATION)).toThrow("EXDEV");
		expect(backupFiles()).toEqual([]);
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
		const damaged = new DatabaseSync(path);
		damaged.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v BLOB)");
		const insert = damaged.prepare("INSERT INTO t VALUES (?, ?)");
		for (let i = 0; i < 200; i++) {
			insert.run(i, Buffer.alloc(100, i));
		}
		damaged.close();
		corrupt(path);

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

	it("backs up the database where the API keeps it without DATABASE_PATH", () => {
		// The default is relative to the working directory: run from one of the
		// test's own, whatever ./data holds where the tests run.
		const home = resolve(DIR, "home");
		const { databasePath } = parseConfig({
			SERVER_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
		} as NodeJS.ProcessEnv);
		mkdirSync(resolve(home, "data"), { recursive: true });
		connections.push(createDatabase(resolve(home, databasePath)).sqlite);
		const out = vi.spyOn(console, "log").mockImplementation(() => {});
		const cwd = process.cwd();

		process.chdir(home);
		try {
			expect(runBackupCommand(["backup.db"], {})).toBe(0);
		} finally {
			process.chdir(cwd);
		}

		expect(out).toHaveBeenCalledWith(
			expect.stringContaining(
				`Backed up ${resolve(home, databasePath)} to ${resolve(home, "backup.db")} (`,
			),
		);
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

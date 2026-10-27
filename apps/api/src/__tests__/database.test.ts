import { once } from "node:events";
import { mkdirSync, rmSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "../db/index.js";

const TEST_DB_PATH = "./data/database-test.db";

let sqlite: DatabaseSync;

function removeTestDb(): void {
	rmSync(TEST_DB_PATH, { force: true });
	rmSync(`${TEST_DB_PATH}-wal`, { force: true });
	rmSync(`${TEST_DB_PATH}-shm`, { force: true });
}

/** A PRAGMA's value, whatever its column is called. */
function pragma(name: string): unknown {
	return Object.values(sqlite.prepare(`PRAGMA ${name}`).get() ?? {})[0];
}

// Another connection, in a thread of its own, that takes the write lock, waits
// for the main thread to be about to write, holds the lock `holdMs` longer,
// then commits and reports when it let go.
const LOCK_HOLDER = `
const { DatabaseSync } = require("node:sqlite");
const { parentPort, workerData } = require("node:worker_threads");
const writing = new Int32Array(workerData.writing);
const db = new DatabaseSync(workerData.path);
db.exec("BEGIN IMMEDIATE");
parentPort.postMessage("locked");
Atomics.wait(writing, 0, 0);
Atomics.wait(writing, 0, 1, workerData.holdMs);
const releasedAt = Date.now();
db.exec("COMMIT");
db.close();
parentPort.postMessage(releasedAt);
`;

beforeAll(() => {
	mkdirSync("./data", { recursive: true });
});

beforeEach(() => {
	removeTestDb();
	({ sqlite } = createDatabase(TEST_DB_PATH));
});

afterEach(() => {
	sqlite.close();
});

afterAll(() => {
	removeTestDb();
});

describe("createDatabase", () => {
	it("syncs every commit, so a read that burned a note survives a power cut", () => {
		expect(pragma("journal_mode")).toBe("wal");
		expect(pragma("synchronous")).toBe(2); // FULL
	});

	it("waits up to 5 s for a lock, and bounds the WAL left after a burst to 64 MiB", () => {
		expect(pragma("busy_timeout")).toBe(5_000);
		expect(pragma("journal_size_limit")).toBe(64 * 1024 * 1024);
	});

	it("keeps the other settings", () => {
		expect(pragma("foreign_keys")).toBe(1);
		expect(pragma("secure_delete")).toBe(1);
		expect(pragma("temp_store")).toBe(2); // MEMORY
	});

	it("waits for a lock another connection holds instead of failing at once", async () => {
		const writing = new Int32Array(new SharedArrayBuffer(4));
		const holder = new Worker(LOCK_HOLDER, {
			eval: true,
			workerData: { path: TEST_DB_PATH, holdMs: 200, writing: writing.buffer },
		});
		await once(holder, "message");
		const released = once(holder, "message");

		// From here the holder keeps the lock 200 ms more: the insert below meets
		// it, and without a busy timeout would fail at once with SQLITE_BUSY.
		Atomics.store(writing, 0, 1);
		Atomics.notify(writing, 0);
		sqlite.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("waited", "yes");
		const insertedAt = Date.now();
		const [releasedAt] = (await released) as [number];
		await once(holder, "exit");

		// It went through once the lock was let go, not before. An order rather
		// than a duration: how late this thread runs cannot make it fail.
		expect(insertedAt).toBeGreaterThanOrEqual(releasedAt);
		expect(sqlite.prepare("SELECT value FROM meta WHERE key = 'waited'").get()).toEqual({
			value: "yes",
		});
	});
});

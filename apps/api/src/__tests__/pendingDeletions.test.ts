import { existsSync, mkdirSync, rmSync } from "node:fs";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppDatabase } from "../db/index.js";
import { createDatabase } from "../db/index.js";
import { pendingDeletions } from "../db/schema.js";
import {
	cancelDeletion,
	drainPendingDeletions,
	enqueueDeletion,
	runDeletion,
} from "../pendingDeletions.js";
import { LocalStorage } from "../storage/local.js";
import { stubStorage } from "./storageDoubles.js";

const TEST_DB_PATH = "./data/pending-deletions-test.db";
const TEST_FILES_PATH = "./data/pending-deletions-test-files";

let db: AppDatabase;
let storage: LocalStorage;

beforeEach(() => {
	try {
		rmSync(TEST_DB_PATH, { force: true });
		rmSync(`${TEST_DB_PATH}-wal`, { force: true });
		rmSync(`${TEST_DB_PATH}-shm`, { force: true });
		rmSync(TEST_FILES_PATH, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
	mkdirSync("./data", { recursive: true });
	mkdirSync(TEST_FILES_PATH, { recursive: true });
	db = createDatabase(TEST_DB_PATH).db;
	storage = new LocalStorage(TEST_FILES_PATH);
});

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(() => {
	try {
		rmSync(TEST_DB_PATH, { force: true });
		rmSync(`${TEST_DB_PATH}-wal`, { force: true });
		rmSync(`${TEST_DB_PATH}-shm`, { force: true });
		rmSync(TEST_FILES_PATH, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

function queue(noteId: string, overrides: { attempts?: number; nextRetryAt?: Date } = {}): void {
	db.insert(pendingDeletions)
		.values({
			noteId,
			attempts: overrides.attempts ?? 0,
			nextRetryAt: overrides.nextRetryAt ?? new Date(Date.now() - 1000),
			createdAt: new Date(),
		})
		.run();
}

/** Timestamps are stored to the second: within a second either way of `expected`. */
function expectAbout(actual: Date | undefined, expected: number): void {
	expect(actual?.getTime()).toBeGreaterThanOrEqual(expected - 1000);
	expect(actual?.getTime()).toBeLessThanOrEqual(expected + 1000);
}

describe("enqueueDeletion", () => {
	it("records the purge in the caller's transaction, held off by the retry delay", () => {
		const before = Date.now();
		const deletion = db.transaction((tx) => enqueueDeletion(tx, "note0001"));

		const rows = db.select().from(pendingDeletions).all();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.id).toBe(deletion.id);
		expect(deletion.noteId).toBe("note0001");
		expect(rows[0]?.attempts).toBe(0);
		expectAbout(rows[0]?.nextRetryAt, before + 30_000);
	});

	it("takes a longer delay when the caller needs the payload for a while", () => {
		const before = Date.now();
		db.transaction((tx) => enqueueDeletion(tx, "note0002", 3_600_000));

		expectAbout(db.select().from(pendingDeletions).get()?.nextRetryAt, before + 3_600_000);
	});

	it("is rolled back with the transaction that queued it", () => {
		expect(() =>
			db.transaction((tx) => {
				enqueueDeletion(tx, "note0003");
				throw new Error("abort");
			}),
		).toThrow("abort");

		expect(db.select().from(pendingDeletions).all()).toHaveLength(0);
	});

	it("is dropped by cancelDeletion", () => {
		const deletion = db.transaction((tx) => enqueueDeletion(tx, "note0004"));
		db.transaction((tx) => cancelDeletion(tx, deletion));

		expect(db.select().from(pendingDeletions).all()).toHaveLength(0);
	});
});

describe("runDeletion", () => {
	it("purges the payload and drops the row", async () => {
		const key = await storage.save("ok000001", Buffer.from("data"));
		const deletion = db.transaction((tx) => enqueueDeletion(tx, "ok000001"));

		await runDeletion(db, storage, deletion);

		expect(existsSync(key)).toBe(false);
		expect(db.select().from(pendingDeletions).all()).toHaveLength(0);
	});

	it("keeps the row for a retry when the purge fails, and logs the row id only", async () => {
		const failing = stubStorage({ purge: vi.fn().mockRejectedValue(new Error("boom")) });
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const deletion = db.transaction((tx) => enqueueDeletion(tx, "fail0001"));

		await runDeletion(db, failing, deletion);

		expect(db.select().from(pendingDeletions).all()).toHaveLength(1);
		const logged = String(consoleSpy.mock.calls[0]?.[0]);
		expect(logged).toContain(
			`"msg":"storage purge failed, retry scheduled","deletionId":${String(deletion.id)},"detail":"Error"`,
		);
		expect(logged).not.toContain("fail0001");
	});

	it("never logs a failure's message, which can carry the note's path", async () => {
		const erofs = Object.assign(new Error("EROFS: read-only file system, rmdir '/data/fail0002'"), {
			code: "EROFS",
		});
		const failing = stubStorage({ purge: vi.fn().mockRejectedValue(erofs) });
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const deletion = db.transaction((tx) => enqueueDeletion(tx, "fail0002"));

		await runDeletion(db, failing, deletion);

		const logged = String(consoleSpy.mock.calls[0]?.[0]);
		expect(logged).toContain('"detail":"EROFS"');
		expect(logged).not.toContain("fail0002");
	});

	it("names only the type of a non-Error rejection", async () => {
		const failing = stubStorage({ purge: vi.fn().mockRejectedValue("plain string") });
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const deletion = db.transaction((tx) => enqueueDeletion(tx, "fail0003"));

		await runDeletion(db, failing, deletion);

		expect(String(consoleSpy.mock.calls[0]?.[0])).toContain('"detail":"string"');
	});

	it("retries a failed purge on the backoff schedule, not after the hold it was queued with", async () => {
		const failing = stubStorage({ purge: vi.fn().mockRejectedValue(new Error("blip")) });
		vi.spyOn(console, "error").mockImplementation(() => {});
		const deletion = db.transaction((tx) => enqueueDeletion(tx, "fail0004", 24 * 60 * 60_000));
		const before = Date.now();

		await runDeletion(db, failing, deletion);

		expectAbout(db.select().from(pendingDeletions).get()?.nextRetryAt, before + 30_000);
	});

	it("keeps the first delay when the database cannot reschedule either", async () => {
		const failing = stubStorage({ purge: vi.fn().mockRejectedValue(new Error("blip")) });
		vi.spyOn(console, "error").mockImplementation(() => {});
		const deletion = db.transaction((tx) => enqueueDeletion(tx, "fail0005", 3_600_000));
		const brokenDb = new Proxy(db, {
			get(target, prop, receiver) {
				if (prop === "update") {
					return () => {
						throw new Error("database is locked");
					};
				}
				const value = Reflect.get(target, prop, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});

		await expect(runDeletion(brokenDb, failing, deletion)).resolves.toBeUndefined();

		expect(db.select().from(pendingDeletions).get()?.nextRetryAt.getTime()).toBeGreaterThan(
			Date.now() + 59 * 60_000,
		);
	});
});

describe("drainPendingDeletions", () => {
	it("returns zeros when there is nothing to drain", async () => {
		const result = await drainPendingDeletions(db, storage);
		expect(result).toEqual({ drained: 0, failed: 0, abandoned: 0 });
	});

	it("purges due deletions and removes their rows", async () => {
		const key = await storage.save("recover01", Buffer.from("data"));
		await storage.saveChunk("recover02", 0, Buffer.from("a"));
		queue("recover01");
		queue("recover02");

		const result = await drainPendingDeletions(db, storage);

		expect(result).toEqual({ drained: 2, failed: 0, abandoned: 0 });
		expect(existsSync(key)).toBe(false);
		expect(existsSync(`${TEST_FILES_PATH}/recover02`)).toBe(false);
		expect(db.select().from(pendingDeletions).all()).toHaveLength(0);
	});

	it("skips entries whose nextRetryAt is in the future", async () => {
		queue("future001", { nextRetryAt: new Date(Date.now() + 60_000) });

		const result = await drainPendingDeletions(db, storage);
		expect(result).toEqual({ drained: 0, failed: 0, abandoned: 0 });
		expect(db.select().from(pendingDeletions).all()).toHaveLength(1);
	});

	it("increments attempts and reschedules on the next backoff step when storage still fails", async () => {
		const failing = stubStorage({ purge: vi.fn().mockRejectedValue(new Error("still down")) });
		queue("retry0001");
		const before = Date.now();

		const result = await drainPendingDeletions(db, failing);
		expect(result).toEqual({ drained: 0, failed: 1, abandoned: 0 });
		const rows = db.select().from(pendingDeletions).all();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.attempts).toBe(1);
		expectAbout(rows[0]?.nextRetryAt, before + 2 * 60_000);
	});

	it("still retries on the attempt before the last", async () => {
		const failing = stubStorage({ purge: vi.fn().mockRejectedValue(new Error("down")) });
		queue("retry0002", { attempts: 4 });
		const before = Date.now();

		await drainPendingDeletions(db, failing);

		const [row] = db.select().from(pendingDeletions).all();
		expect(row?.attempts).toBe(5);
		expectAbout(row?.nextRetryAt, before + 24 * 60 * 60_000);
	});

	it("handles non-Error rejections from storage during drain", async () => {
		const failing = stubStorage({ purge: vi.fn().mockRejectedValue("plain string failure") });
		queue("stringfail");

		const result = await drainPendingDeletions(db, failing);
		expect(result).toEqual({ drained: 0, failed: 1, abandoned: 0 });
		expect(db.select().from(pendingDeletions).all()[0]?.attempts).toBe(1);
	});

	it("gives up after MAX_ATTEMPTS and removes the row", async () => {
		const failing = stubStorage({ purge: vi.fn().mockRejectedValue(new Error("permafail")) });
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		queue("giveup001", { attempts: 5 }); // one less than MAX_ATTEMPTS=6

		const result = await drainPendingDeletions(db, failing);
		expect(result).toEqual({ drained: 0, failed: 1, abandoned: 1 });
		expect(db.select().from(pendingDeletions).all()).toHaveLength(0);
		const logged = String(consoleSpy.mock.calls[0]?.[0]);
		expect(logged).toContain('"msg":"giving up on pending deletion"');
		expect(logged).toContain('"attempts":6,"detail":"Error"');
		expect(logged).not.toContain("giveup001");
	});

	it("respects the concurrency cap when draining many entries", async () => {
		for (let i = 0; i < 5; i++) {
			await storage.save(`many${String(i)}`, Buffer.from("data"));
			queue(`many${String(i)}`);
		}

		const result = await drainPendingDeletions(db, storage, 2);
		expect(result.drained).toBe(5);
		expect(db.select().from(pendingDeletions).all()).toHaveLength(0);
	});
});

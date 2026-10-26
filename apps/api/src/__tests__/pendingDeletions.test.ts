import { existsSync, mkdirSync, rmSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppDatabase } from "../db/index.js";
import { createDatabase } from "../db/index.js";
import { pendingDeletions } from "../db/schema.js";
import {
	cancelDeletion,
	drainPendingDeletions,
	enqueueDeletion,
	hasStoredPayload,
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

describe("hasStoredPayload", () => {
	it("is true for a file note or a chunked note, false for an inline one", () => {
		expect(hasStoredPayload({ filePath: "/data/files/x", chunkCount: null })).toBe(true);
		expect(hasStoredPayload({ filePath: null, chunkCount: 3 })).toBe(true);
		expect(hasStoredPayload({ filePath: null, chunkCount: null })).toBe(false);
		expect(hasStoredPayload({ filePath: null, chunkCount: 0 })).toBe(false);
	});
});

describe("enqueueDeletion", () => {
	it("records the purge in the caller's transaction, held off by the retry delay", () => {
		const before = Date.now();
		const deletion = db.transaction((tx) => enqueueDeletion(tx, "note0001"));

		const rows = db.select().from(pendingDeletions).all();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.id).toBe(deletion.id);
		expect(deletion.noteId).toBe("note0001");
		expect(rows[0]?.attempts).toBe(0);
		expect(rows[0]?.nextRetryAt.getTime()).toBeGreaterThanOrEqual(before + 30_000 - 1000);
	});

	it("takes a longer delay when the caller needs the payload for a while", () => {
		const before = Date.now();
		db.transaction((tx) => enqueueDeletion(tx, "note0002", 3_600_000));

		const row = db.select().from(pendingDeletions).get();
		expect(row?.nextRetryAt.getTime()).toBeGreaterThanOrEqual(before + 3_600_000 - 1000);
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
			`"msg":"storage purge failed, retry scheduled","deletionId":${String(deletion.id)},"detail":"boom"`,
		);
		expect(logged).not.toContain("fail0001");
		consoleSpy.mockRestore();
	});

	it("logs a non-Error rejection as text", async () => {
		const failing = stubStorage({ purge: vi.fn().mockRejectedValue("plain string") });
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const deletion = db.transaction((tx) => enqueueDeletion(tx, "fail0002"));

		await runDeletion(db, failing, deletion);

		expect(String(consoleSpy.mock.calls[0]?.[0])).toContain('"detail":"plain string"');
		consoleSpy.mockRestore();
	});
});

describe("drainPendingDeletions", () => {
	it("returns 0/0 when there is nothing to drain", async () => {
		const result = await drainPendingDeletions(db, storage);
		expect(result).toEqual({ drained: 0, failed: 0 });
	});

	it("purges due deletions and removes their rows", async () => {
		const key = await storage.save("recover01", Buffer.from("data"));
		await storage.saveChunk("recover02", 0, Buffer.from("a"));
		queue("recover01");
		queue("recover02");

		const result = await drainPendingDeletions(db, storage);

		expect(result).toEqual({ drained: 2, failed: 0 });
		expect(existsSync(key)).toBe(false);
		expect(existsSync(`${TEST_FILES_PATH}/recover02`)).toBe(false);
		expect(db.select().from(pendingDeletions).all()).toHaveLength(0);
	});

	it("skips entries whose nextRetryAt is in the future", async () => {
		queue("future001", { nextRetryAt: new Date(Date.now() + 60_000) });

		const result = await drainPendingDeletions(db, storage);
		expect(result).toEqual({ drained: 0, failed: 0 });
		expect(db.select().from(pendingDeletions).all()).toHaveLength(1);
	});

	it("increments attempts and reschedules when storage still fails", async () => {
		const failing = stubStorage({ purge: vi.fn().mockRejectedValue(new Error("still down")) });
		queue("retry0001");

		const result = await drainPendingDeletions(db, failing);
		expect(result).toEqual({ drained: 0, failed: 1 });
		const rows = db.select().from(pendingDeletions).all();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.attempts).toBe(1);
		expect(rows[0]?.nextRetryAt.getTime()).toBeGreaterThan(Date.now());
	});

	it("handles non-Error rejections from storage during drain", async () => {
		const failing = stubStorage({ purge: vi.fn().mockRejectedValue("plain string failure") });
		queue("stringfail");

		const result = await drainPendingDeletions(db, failing);
		expect(result).toEqual({ drained: 0, failed: 1 });
		expect(db.select().from(pendingDeletions).all()[0]?.attempts).toBe(1);
	});

	it("gives up after MAX_ATTEMPTS and removes the row", async () => {
		const failing = stubStorage({ purge: vi.fn().mockRejectedValue(new Error("permafail")) });
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		queue("giveup001", { attempts: 5 }); // one less than MAX_ATTEMPTS=6

		const result = await drainPendingDeletions(db, failing);
		expect(result).toEqual({ drained: 0, failed: 1 });
		expect(db.select().from(pendingDeletions).all()).toHaveLength(0);
		const logged = String(consoleSpy.mock.calls[0]?.[0]);
		expect(logged).toContain('"msg":"giving up on pending deletion"');
		expect(logged).toContain('"attempts":6,"detail":"permafail"');
		expect(logged).not.toContain("giveup001");
		consoleSpy.mockRestore();
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

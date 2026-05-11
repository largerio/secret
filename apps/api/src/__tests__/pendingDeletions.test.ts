import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppDatabase } from "../db/index.js";
import { createDatabase } from "../db/index.js";
import { pendingDeletions } from "../db/schema.js";
import {
	deleteOrSchedule,
	drainPendingDeletions,
	schedulePendingDeletion,
} from "../pendingDeletions.js";
import type { StorageBackend } from "../storage/index.js";
import { LocalStorage } from "../storage/local.js";

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

describe("schedulePendingDeletion", () => {
	it("inserts a row for a file deletion", () => {
		schedulePendingDeletion(db, { noteId: "note0001", filePath: "/tmp/missing" });
		const rows = db.select().from(pendingDeletions).all();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.noteId).toBe("note0001");
		expect(rows[0]?.filePath).toBe("/tmp/missing");
		expect(rows[0]?.chunkCount).toBeNull();
		expect(rows[0]?.attempts).toBe(0);
	});

	it("inserts a row for a chunked deletion", () => {
		schedulePendingDeletion(db, { noteId: "note0002", chunkCount: 5 });
		const rows = db.select().from(pendingDeletions).all();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.chunkCount).toBe(5);
		expect(rows[0]?.filePath).toBeNull();
	});

	it("ignores empty targets (no file, no chunks)", () => {
		schedulePendingDeletion(db, { noteId: "note0003" });
		schedulePendingDeletion(db, { noteId: "note0004", filePath: null, chunkCount: 0 });
		const rows = db.select().from(pendingDeletions).all();
		expect(rows).toHaveLength(0);
	});
});

describe("deleteOrSchedule", () => {
	it("deletes file successfully without scheduling", async () => {
		const filePath = `${TEST_FILES_PATH}/file-ok`;
		writeFileSync(filePath, "data");

		await deleteOrSchedule(db, storage, { noteId: "ok000001", filePath });

		const rows = db.select().from(pendingDeletions).all();
		expect(rows).toHaveLength(0);
	});

	it("deletes chunks successfully without scheduling", async () => {
		const noteId = "chunkok01";
		await storage.saveChunk(noteId, 0, Buffer.from("chunk0"));
		await storage.saveChunk(noteId, 1, Buffer.from("chunk1"));

		await deleteOrSchedule(db, storage, { noteId, chunkCount: 2 });

		const rows = db.select().from(pendingDeletions).all();
		expect(rows).toHaveLength(0);
	});

	it("schedules retry when file delete throws", async () => {
		const failingStorage: StorageBackend = {
			save: vi.fn(),
			read: vi.fn(),
			delete: vi.fn().mockRejectedValue(new Error("boom")),
			saveChunk: vi.fn(),
			readChunk: vi.fn(),
			deleteChunks: vi.fn(),
		};
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await deleteOrSchedule(db, failingStorage, { noteId: "fail0001", filePath: "/tmp/x" });

		const rows = db.select().from(pendingDeletions).all();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.noteId).toBe("fail0001");
		expect(consoleSpy).toHaveBeenCalledWith(
			"[deletions] Storage delete failed for note fail0001, scheduling retry: boom",
		);
		consoleSpy.mockRestore();
	});

	it("schedules retry when chunk delete throws", async () => {
		const failingStorage: StorageBackend = {
			save: vi.fn(),
			read: vi.fn(),
			delete: vi.fn(),
			saveChunk: vi.fn(),
			readChunk: vi.fn(),
			deleteChunks: vi.fn().mockRejectedValue(new Error("boom")),
		};
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await deleteOrSchedule(db, failingStorage, { noteId: "fail0002", chunkCount: 3 });

		const rows = db.select().from(pendingDeletions).all();
		expect(rows).toHaveLength(1);
		consoleSpy.mockRestore();
	});

	it("ignores empty targets without touching storage", async () => {
		const storageSpy = {
			save: vi.fn(),
			read: vi.fn(),
			delete: vi.fn(),
			saveChunk: vi.fn(),
			readChunk: vi.fn(),
			deleteChunks: vi.fn(),
		};
		await deleteOrSchedule(db, storageSpy, { noteId: "noop0001" });
		expect(storageSpy.delete).not.toHaveBeenCalled();
		expect(storageSpy.deleteChunks).not.toHaveBeenCalled();
	});
});

describe("drainPendingDeletions", () => {
	it("returns 0/0 when there is nothing to drain", async () => {
		const result = await drainPendingDeletions(db, storage);
		expect(result).toEqual({ drained: 0, failed: 0 });
	});

	it("retries scheduled deletions and removes them when they succeed", async () => {
		const filePath = `${TEST_FILES_PATH}/recoverable`;
		writeFileSync(filePath, "data");

		// Schedule with nextRetryAt in the past so it gets picked up immediately
		db.insert(pendingDeletions)
			.values({
				noteId: "recover01",
				filePath,
				chunkCount: null,
				attempts: 0,
				nextRetryAt: new Date(Date.now() - 1000),
				createdAt: new Date(),
			})
			.run();

		const result = await drainPendingDeletions(db, storage);
		expect(result.drained).toBe(1);
		expect(result.failed).toBe(0);
		expect(db.select().from(pendingDeletions).all()).toHaveLength(0);
	});

	it("skips entries whose nextRetryAt is in the future", async () => {
		db.insert(pendingDeletions)
			.values({
				noteId: "future001",
				filePath: "/tmp/nope",
				chunkCount: null,
				attempts: 0,
				nextRetryAt: new Date(Date.now() + 60_000),
				createdAt: new Date(),
			})
			.run();

		const result = await drainPendingDeletions(db, storage);
		expect(result).toEqual({ drained: 0, failed: 0 });
		expect(db.select().from(pendingDeletions).all()).toHaveLength(1);
	});

	it("increments attempts and reschedules when storage still fails", async () => {
		const failingStorage: StorageBackend = {
			save: vi.fn(),
			read: vi.fn(),
			delete: vi.fn().mockRejectedValue(new Error("still down")),
			saveChunk: vi.fn(),
			readChunk: vi.fn(),
			deleteChunks: vi.fn(),
		};

		db.insert(pendingDeletions)
			.values({
				noteId: "retry0001",
				filePath: "/tmp/x",
				chunkCount: null,
				attempts: 0,
				nextRetryAt: new Date(Date.now() - 1000),
				createdAt: new Date(),
			})
			.run();

		const result = await drainPendingDeletions(db, failingStorage);
		expect(result).toEqual({ drained: 0, failed: 1 });
		const rows = db.select().from(pendingDeletions).all();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.attempts).toBe(1);
		expect(rows[0]?.nextRetryAt.getTime()).toBeGreaterThan(Date.now());
	});

	it("handles non-Error rejections from storage during drain", async () => {
		const failingStorage: StorageBackend = {
			save: vi.fn(),
			read: vi.fn(),
			delete: vi.fn().mockRejectedValue("plain string failure"),
			saveChunk: vi.fn(),
			readChunk: vi.fn(),
			deleteChunks: vi.fn(),
		};

		db.insert(pendingDeletions)
			.values({
				noteId: "stringfail",
				filePath: "/tmp/x",
				chunkCount: null,
				attempts: 0,
				nextRetryAt: new Date(Date.now() - 1000),
				createdAt: new Date(),
			})
			.run();

		const result = await drainPendingDeletions(db, failingStorage);
		expect(result).toEqual({ drained: 0, failed: 1 });
		const rows = db.select().from(pendingDeletions).all();
		expect(rows[0]?.attempts).toBe(1);
	});

	it("gives up after MAX_ATTEMPTS and removes the row", async () => {
		const failingStorage: StorageBackend = {
			save: vi.fn(),
			read: vi.fn(),
			delete: vi.fn().mockRejectedValue(new Error("permafail")),
			saveChunk: vi.fn(),
			readChunk: vi.fn(),
			deleteChunks: vi.fn(),
		};
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		db.insert(pendingDeletions)
			.values({
				noteId: "giveup001",
				filePath: "/tmp/x",
				chunkCount: null,
				attempts: 5, // one less than MAX_ATTEMPTS=6
				nextRetryAt: new Date(Date.now() - 1000),
				createdAt: new Date(),
			})
			.run();

		const result = await drainPendingDeletions(db, failingStorage);
		expect(result).toEqual({ drained: 0, failed: 1 });
		expect(db.select().from(pendingDeletions).all()).toHaveLength(0);
		expect(consoleSpy).toHaveBeenCalledWith(
			"[deletions] Giving up on note giveup001 after 6 attempts: permafail",
		);
		consoleSpy.mockRestore();
	});

	it("removes malformed rows (no filePath and no chunks) without retrying", async () => {
		db.insert(pendingDeletions)
			.values({
				noteId: "malformed1",
				filePath: null,
				chunkCount: null,
				attempts: 0,
				nextRetryAt: new Date(Date.now() - 1000),
				createdAt: new Date(),
			})
			.run();

		const result = await drainPendingDeletions(db, storage);
		expect(result).toEqual({ drained: 0, failed: 0 });
		expect(db.select().from(pendingDeletions).all()).toHaveLength(0);
	});

	it("drains chunked deletions as well", async () => {
		const noteId = "drainchk01";
		await storage.saveChunk(noteId, 0, Buffer.from("a"));
		await storage.saveChunk(noteId, 1, Buffer.from("b"));

		db.insert(pendingDeletions)
			.values({
				noteId,
				filePath: null,
				chunkCount: 2,
				attempts: 0,
				nextRetryAt: new Date(Date.now() - 1000),
				createdAt: new Date(),
			})
			.run();

		const result = await drainPendingDeletions(db, storage);
		expect(result.drained).toBe(1);
	});

	it("respects the concurrency cap when draining many entries", async () => {
		// Insert 5 entries all due
		for (let i = 0; i < 5; i++) {
			const filePath = `${TEST_FILES_PATH}/many${i}`;
			writeFileSync(filePath, "data");
			db.insert(pendingDeletions)
				.values({
					noteId: `many${String(i)}`,
					filePath,
					chunkCount: null,
					attempts: 0,
					nextRetryAt: new Date(Date.now() - 1000),
					createdAt: new Date(),
				})
				.run();
		}

		const result = await drainPendingDeletions(db, storage, 2);
		expect(result.drained).toBe(5);
		expect(db.select().from(pendingDeletions).all()).toHaveLength(0);
	});
});

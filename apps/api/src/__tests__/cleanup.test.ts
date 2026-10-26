import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { serverEncrypt } from "@largerio/secret-crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCleanup, startCleanupJob } from "../cleanup.js";
import type { AppDatabase } from "../db/index.js";
import { createDatabase } from "../db/index.js";
import { notes, pendingDeletions, uploads } from "../db/schema.js";
import { LocalStorage } from "../storage/local.js";
import { stubStorage } from "./storageDoubles.js";

const TEST_DB_PATH = "./data/cleanup-test.db";
const TEST_FILES_PATH = "./data/cleanup-test-files";
const TEST_SERVER_KEY = randomBytes(32);

let db: AppDatabase;
let storage: LocalStorage;

function insertNote(id: string, overrides: Partial<Record<string, unknown>> = {}) {
	const { encrypted, iv } = serverEncrypt(Buffer.from("test"), TEST_SERVER_KEY);
	db.insert(notes)
		.values({
			id,
			encryptedData: encrypted,
			serverNonce: iv.toString("base64"),
			clientNonce: "test",
			hasPassword: false,
			deleteToken: "test-token",
			fileCount: 0,
			filePath: null,
			expiresAt: new Date(Date.now() - 10_000),
			createdAt: new Date(),
			...overrides,
		})
		.run();
}

function insertUpload(id: string, noteId: string, expiresAt: Date) {
	db.insert(uploads)
		.values({
			id,
			metadata: "{}",
			chunkCount: 2,
			noteId,
			deleteToken: "tok",
			createdAt: new Date(),
			expiresAt,
		})
		.run();
}

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

describe("runCleanup", () => {
	it("removes expired notes and leaves the others", async () => {
		insertNote("expired00001");
		insertNote("expired00002");
		insertNote("stillgood001", { expiresAt: new Date(Date.now() + 3_600_000) });

		await runCleanup(db, storage);

		const remaining = db.select().from(notes).all();
		expect(remaining.map((note) => note.id)).toEqual(["stillgood001"]);
	});

	it("purges the payload of expired file and chunked notes", async () => {
		const filePath = await storage.save("expiredfile1", Buffer.from("encrypted-data"));
		await storage.saveChunk("chunked00001", 0, Buffer.from("c0"));
		insertNote("expiredfile1", { fileCount: 1, filePath });
		insertNote("chunked00001", { chunkCount: 1, streamHeader: "header" });

		await runCleanup(db, storage);

		expect(existsSync(filePath)).toBe(false);
		expect(existsSync(`${TEST_FILES_PATH}/chunked00001`)).toBe(false);
		expect(db.select().from(pendingDeletions).all()).toHaveLength(0);
	});

	it("queues no purge for an inline note", async () => {
		const tracked = stubStorage();
		insertNote("inline000001");

		await runCleanup(db, tracked);

		expect(tracked.purge).not.toHaveBeenCalled();
		expect(db.select().from(pendingDeletions).all()).toHaveLength(0);
	});

	it("queues the purge with the row deletion, so an interrupted purge is not lost", async () => {
		// A purge that never settles stands for a crash right after the commit.
		const hanging = stubStorage({ purge: vi.fn(() => new Promise<void>(() => {})) });
		insertNote("crashed00001", { fileCount: 1, filePath: "/data/files/crashed00001" });

		void runCleanup(db, hanging);
		await vi.waitFor(() => expect(hanging.purge).toHaveBeenCalled());

		expect(db.select().from(notes).all()).toHaveLength(0);
		expect(
			db
				.select()
				.from(pendingDeletions)
				.all()
				.map((row) => row.noteId),
		).toEqual(["crashed00001"]);
	});

	it("keeps a failed purge queued for a retry, and still deletes the note", async () => {
		const failing = stubStorage({ purge: vi.fn().mockRejectedValue(new Error("disk error")) });
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		insertNote("faildelete01", { fileCount: 1, filePath: "/data/files/faildelete01" });

		await runCleanup(db, failing);

		expect(db.select().from(notes).all()).toHaveLength(0);
		const [pending] = db.select().from(pendingDeletions).all();
		expect(pending?.noteId).toBe("faildelete01");
		expect(pending?.nextRetryAt.getTime()).toBeGreaterThan(Date.now());
		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining('"msg":"storage purge failed, retry scheduled"'),
		);
	});

	it("removes expired upload sessions and purges their chunks", async () => {
		await storage.saveChunk("uploadnote01", 0, Buffer.from("c0"));
		insertUpload("upload000001", "uploadnote01", new Date(Date.now() - 10_000));
		insertUpload("upload000002", "uploadnote02", new Date(Date.now() + 3_600_000));

		await runCleanup(db, storage);

		expect(
			db
				.select()
				.from(uploads)
				.all()
				.map((upload) => upload.id),
		).toEqual(["upload000002"]);
		expect(existsSync(`${TEST_FILES_PATH}/uploadnote01`)).toBe(false);
		expect(db.select().from(pendingDeletions).all()).toHaveLength(0);
	});

	it("keeps the purge of an expired session queued when it fails", async () => {
		const failing = stubStorage({ purge: vi.fn().mockRejectedValue(new Error("s3 down")) });
		vi.spyOn(console, "error").mockImplementation(() => {});
		insertUpload("upload000003", "uploadnote03", new Date(Date.now() - 10_000));

		await runCleanup(db, failing);

		expect(db.select().from(uploads).all()).toHaveLength(0);
		expect(
			db
				.select()
				.from(pendingDeletions)
				.all()
				.map((row) => row.noteId),
		).toEqual(["uploadnote03"]);
	});

	it("drains due pending deletions", async () => {
		await storage.save("drainnote01", Buffer.from("data"));
		db.insert(pendingDeletions)
			.values({
				noteId: "drainnote01",
				attempts: 0,
				nextRetryAt: new Date(Date.now() - 1000),
				createdAt: new Date(),
			})
			.run();
		const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await runCleanup(db, storage);

		expect(db.select().from(pendingDeletions).all()).toHaveLength(0);
		expect(existsSync(`${TEST_FILES_PATH}/drainnote01`)).toBe(false);
		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining('"msg":"pending deletions drained","drained":1,"failed":0'),
		);
	});

	it("does not retry a purge it has just queued", async () => {
		const failing = stubStorage({ purge: vi.fn().mockRejectedValue(new Error("down")) });
		vi.spyOn(console, "error").mockImplementation(() => {});
		insertNote("justqueued01", { fileCount: 1, filePath: "/data/files/justqueued01" });

		await runCleanup(db, failing);

		// One attempt right after the commit; the drain waits for the retry delay.
		expect(failing.purge).toHaveBeenCalledOnce();
		expect(db.select().from(pendingDeletions).all()[0]?.attempts).toBe(0);
	});

	it("logs and survives a database failure", async () => {
		const failingDb = {
			transaction: () => {
				throw new Error("database locked");
			},
		} as unknown as AppDatabase;
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await runCleanup(failingDb, storage);

		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining('"msg":"cleanup job failed","detail":"database locked"'),
		);
	});

	it("logs a non-Error failure as is", async () => {
		const failingDb = {
			transaction: () => {
				throw "string error";
			},
		} as unknown as AppDatabase;
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await runCleanup(failingDb, storage);

		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining('"msg":"cleanup job failed","detail":"string error"'),
		);
	});
});

describe("startCleanupJob", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("runs a cleanup pass on every interval", async () => {
		vi.useFakeTimers();
		insertNote("expired00001");

		const timer = startCleanupJob(db, storage, 100);
		expect(db.select().from(notes).all()).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(100);
		clearInterval(timer);

		expect(db.select().from(notes).all()).toHaveLength(0);
	});
});

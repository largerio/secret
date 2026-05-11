import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { serverEncrypt } from "@secret/crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startCleanupJob } from "../cleanup.js";
import type { AppDatabase } from "../db/index.js";
import { createDatabase } from "../db/index.js";
import { notes, pendingDeletions, uploads } from "../db/schema.js";
import type { StorageBackend } from "../storage/index.js";
import { LocalStorage } from "../storage/local.js";

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
			burnAfterRead: false,
			fileCount: 0,
			filePath: null,
			expiresAt: new Date(Date.now() - 10_000),
			createdAt: new Date(),
			...overrides,
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

describe("startCleanupJob", () => {
	it("removes expired notes", async () => {
		insertNote("expired00001");

		const timer = startCleanupJob(db, storage, 100);
		await new Promise((resolve) => setTimeout(resolve, 250));
		clearInterval(timer);

		const remaining = db.select().from(notes).all();
		expect(remaining).toHaveLength(0);
	});

	it("removes file on disk when cleaning expired note with file", async () => {
		const filePath = `${TEST_FILES_PATH}/expired-file`;
		writeFileSync(filePath, "encrypted-data");

		insertNote("expiredfile1", { fileCount: 1, filePath });

		const timer = startCleanupJob(db, storage, 100);
		await new Promise((resolve) => setTimeout(resolve, 250));
		clearInterval(timer);

		expect(existsSync(filePath)).toBe(false);
	});

	it("does not remove non-expired notes", async () => {
		insertNote("notexpired01", { expiresAt: new Date(Date.now() + 3_600_000) });

		const timer = startCleanupJob(db, storage, 100);
		await new Promise((resolve) => setTimeout(resolve, 250));
		clearInterval(timer);

		const remaining = db.select().from(notes).all();
		expect(remaining).toHaveLength(1);
	});

	it("removes multiple expired notes in one pass", async () => {
		insertNote("expired00001");
		insertNote("expired00002");
		insertNote("expired00003");

		const timer = startCleanupJob(db, storage, 100);
		await new Promise((resolve) => setTimeout(resolve, 250));
		clearInterval(timer);

		const remaining = db.select().from(notes).all();
		expect(remaining).toHaveLength(0);
	});

	it("leaves non-expired notes when removing expired ones", async () => {
		insertNote("expired00001");
		insertNote("stillgood001", { expiresAt: new Date(Date.now() + 3_600_000) });

		const timer = startCleanupJob(db, storage, 100);
		await new Promise((resolve) => setTimeout(resolve, 250));
		clearInterval(timer);

		const remaining = db.select().from(notes).all();
		expect(remaining).toHaveLength(1);
		expect(remaining[0]?.id).toBe("stillgood001");
	});

	it("logs error and still deletes DB record when file deletion fails", async () => {
		const filePath = resolve(`${TEST_FILES_PATH}/fail-delete`);
		writeFileSync(filePath, "encrypted-data");

		const failingStorage: StorageBackend = {
			save: vi.fn(),
			read: vi.fn(),
			delete: vi.fn().mockRejectedValue(new Error("disk error")),
			saveChunk: vi.fn(),
			readChunk: vi.fn(),
			deleteChunks: vi.fn(),
		};

		insertNote("faildelete01", { fileCount: 1, filePath });

		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const timer = startCleanupJob(db, failingStorage, 100);
		await new Promise((resolve) => setTimeout(resolve, 250));
		clearInterval(timer);

		const remaining = db.select().from(notes).all();
		expect(remaining).toHaveLength(0);
		expect(consoleSpy).toHaveBeenCalledWith(
			"[deletions] Storage delete failed for note faildelete01, scheduling retry: disk error",
		);
		consoleSpy.mockRestore();
	});

	it("catches and logs errors when database transaction fails", async () => {
		const failingDb = {
			transaction: () => {
				throw new Error("database locked");
			},
		} as unknown as AppDatabase;

		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const timer = startCleanupJob(failingDb, storage, 100);
		await new Promise((resolve) => setTimeout(resolve, 250));
		clearInterval(timer);

		expect(consoleSpy).toHaveBeenCalledWith("[cleanup] Cleanup job failed:", "database locked");
		consoleSpy.mockRestore();
	});

	it("catches and logs non-Error exceptions in cleanup job", async () => {
		const failingDb = {
			transaction: () => {
				throw "string error";
			},
		} as unknown as AppDatabase;

		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const timer = startCleanupJob(failingDb, storage, 100);
		await new Promise((resolve) => setTimeout(resolve, 250));
		clearInterval(timer);

		expect(consoleSpy).toHaveBeenCalledWith("[cleanup] Cleanup job failed:", "string error");
		consoleSpy.mockRestore();
	});

	it("logs non-Error rejection values in cleanup", async () => {
		const filePath = resolve(`${TEST_FILES_PATH}/fail-str`);
		writeFileSync(filePath, "encrypted-data");

		const failingStorage: StorageBackend = {
			save: vi.fn(),
			read: vi.fn(),
			delete: vi.fn().mockRejectedValue("string-error"),
			saveChunk: vi.fn(),
			readChunk: vi.fn(),
			deleteChunks: vi.fn(),
		};

		insertNote("failstring01", { fileCount: 1, filePath });

		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const timer = startCleanupJob(db, failingStorage, 100);
		await new Promise((resolve) => setTimeout(resolve, 250));
		clearInterval(timer);

		expect(consoleSpy).toHaveBeenCalledWith(
			"[deletions] Storage delete failed for note failstring01, scheduling retry: string-error",
		);
		consoleSpy.mockRestore();
	});

	it("removes expired chunked notes and calls deleteChunks", async () => {
		const mockStorage: StorageBackend = {
			save: vi.fn(),
			read: vi.fn(),
			delete: vi.fn(),
			saveChunk: vi.fn(),
			readChunk: vi.fn(),
			deleteChunks: vi.fn().mockResolvedValue(undefined),
		};

		insertNote("chunked00001", { chunkCount: 3, streamHeader: "header" });

		const timer = startCleanupJob(db, mockStorage, 100);
		await new Promise((resolve) => setTimeout(resolve, 250));
		clearInterval(timer);

		const remaining = db.select().from(notes).all();
		expect(remaining).toHaveLength(0);
		expect(mockStorage.deleteChunks).toHaveBeenCalledWith("chunked00001", 3);
	});

	it("logs non-Error rejection for expired chunked note deleteChunks", async () => {
		const mockStorage: StorageBackend = {
			save: vi.fn(),
			read: vi.fn(),
			delete: vi.fn(),
			saveChunk: vi.fn(),
			readChunk: vi.fn(),
			deleteChunks: vi.fn().mockRejectedValue("string chunk error"),
		};

		insertNote("chunkstr001", { chunkCount: 2, streamHeader: "header" });

		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const timer = startCleanupJob(db, mockStorage, 100);
		await new Promise((resolve) => setTimeout(resolve, 250));
		clearInterval(timer);

		expect(consoleSpy).toHaveBeenCalledWith(
			"[deletions] Storage delete failed for note chunkstr001, scheduling retry: string chunk error",
		);
		consoleSpy.mockRestore();
	});

	it("logs error when deleteChunks fails for expired chunked note", async () => {
		const mockStorage: StorageBackend = {
			save: vi.fn(),
			read: vi.fn(),
			delete: vi.fn(),
			saveChunk: vi.fn(),
			readChunk: vi.fn(),
			deleteChunks: vi.fn().mockRejectedValue(new Error("chunk delete failed")),
		};

		insertNote("chunkfail01", { chunkCount: 2, streamHeader: "header" });

		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const timer = startCleanupJob(db, mockStorage, 100);
		await new Promise((resolve) => setTimeout(resolve, 250));
		clearInterval(timer);

		expect(consoleSpy).toHaveBeenCalledWith(
			"[deletions] Storage delete failed for note chunkfail01, scheduling retry: chunk delete failed",
		);
		consoleSpy.mockRestore();
	});

	it("removes expired upload sessions and calls deleteChunks", async () => {
		const mockStorage: StorageBackend = {
			save: vi.fn(),
			read: vi.fn(),
			delete: vi.fn(),
			saveChunk: vi.fn(),
			readChunk: vi.fn(),
			deleteChunks: vi.fn().mockResolvedValue(undefined),
		};

		db.insert(uploads)
			.values({
				id: "upload000001",
				metadata: "{}",
				chunkCount: 4,
				noteId: "uploadnote01",
				deleteToken: "tok",
				createdAt: new Date(),
				expiresAt: new Date(Date.now() - 10_000),
			})
			.run();

		const timer = startCleanupJob(db, mockStorage, 100);
		await new Promise((resolve) => setTimeout(resolve, 250));
		clearInterval(timer);

		const remainingUploads = db.select().from(uploads).all();
		expect(remainingUploads).toHaveLength(0);
		expect(mockStorage.deleteChunks).toHaveBeenCalledWith("uploadnote01", 4);
	});

	it("logs error when deleteChunks fails for expired upload session", async () => {
		const mockStorage: StorageBackend = {
			save: vi.fn(),
			read: vi.fn(),
			delete: vi.fn(),
			saveChunk: vi.fn(),
			readChunk: vi.fn(),
			deleteChunks: vi.fn().mockRejectedValue(new Error("upload chunk error")),
		};

		db.insert(uploads)
			.values({
				id: "upload000002",
				metadata: "{}",
				chunkCount: 2,
				noteId: "uploadnote02",
				deleteToken: "tok",
				createdAt: new Date(),
				expiresAt: new Date(Date.now() - 10_000),
			})
			.run();

		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const timer = startCleanupJob(db, mockStorage, 100);
		await new Promise((resolve) => setTimeout(resolve, 250));
		clearInterval(timer);

		expect(consoleSpy).toHaveBeenCalledWith(
			"[deletions] Storage delete failed for note uploadnote02, scheduling retry: upload chunk error",
		);
		consoleSpy.mockRestore();
	});

	it("logs non-Error rejection for expired upload session chunk deletion", async () => {
		const mockStorage: StorageBackend = {
			save: vi.fn(),
			read: vi.fn(),
			delete: vi.fn(),
			saveChunk: vi.fn(),
			readChunk: vi.fn(),
			deleteChunks: vi.fn().mockRejectedValue("string-upload-error"),
		};

		db.insert(uploads)
			.values({
				id: "upload000003",
				metadata: "{}",
				chunkCount: 1,
				noteId: "uploadnote03",
				deleteToken: "tok",
				createdAt: new Date(),
				expiresAt: new Date(Date.now() - 10_000),
			})
			.run();

		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const timer = startCleanupJob(db, mockStorage, 100);
		await new Promise((resolve) => setTimeout(resolve, 250));
		clearInterval(timer);

		expect(consoleSpy).toHaveBeenCalledWith(
			"[deletions] Storage delete failed for note uploadnote03, scheduling retry: string-upload-error",
		);
		consoleSpy.mockRestore();
	});

	it("drains pending_deletions on each tick", async () => {
		const filePath = `${TEST_FILES_PATH}/drain-me`;
		writeFileSync(filePath, "data");

		db.insert(pendingDeletions)
			.values({
				noteId: "drainnote1",
				filePath,
				chunkCount: null,
				attempts: 0,
				nextRetryAt: new Date(Date.now() - 1000),
				createdAt: new Date(),
			})
			.run();

		const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const timer = startCleanupJob(db, storage, 100);
		await new Promise((resolve) => setTimeout(resolve, 250));
		clearInterval(timer);

		expect(db.select().from(pendingDeletions).all()).toHaveLength(0);
		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining("[cleanup] pending deletions drained="),
		);
		consoleSpy.mockRestore();
	});

	it("does not delete non-expired upload sessions", async () => {
		const mockStorage: StorageBackend = {
			save: vi.fn(),
			read: vi.fn(),
			delete: vi.fn(),
			saveChunk: vi.fn(),
			readChunk: vi.fn(),
			deleteChunks: vi.fn(),
		};

		db.insert(uploads)
			.values({
				id: "upload000004",
				metadata: "{}",
				chunkCount: 1,
				noteId: "uploadnote04",
				deleteToken: "tok",
				createdAt: new Date(),
				expiresAt: new Date(Date.now() + 3_600_000),
			})
			.run();

		const timer = startCleanupJob(db, mockStorage, 100);
		await new Promise((resolve) => setTimeout(resolve, 250));
		clearInterval(timer);

		const remaining = db.select().from(uploads).all();
		expect(remaining).toHaveLength(1);
		expect(mockStorage.deleteChunks).not.toHaveBeenCalled();
	});
});

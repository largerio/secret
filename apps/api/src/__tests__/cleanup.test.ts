import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { serverEncrypt } from "@secret/crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startCleanupJob } from "../cleanup.js";
import type { AppDatabase } from "../db/index.js";
import { createDatabase } from "../db/index.js";
import { notes } from "../db/schema.js";
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
			expect.stringContaining("[cleanup] Failed to delete file for note faildelete01"),
			"disk error",
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
			expect.stringContaining("[cleanup] Failed to delete file for note failstring01"),
			"string-error",
		);
		consoleSpy.mockRestore();
	});
});

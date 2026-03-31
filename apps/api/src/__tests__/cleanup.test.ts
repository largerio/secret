import { describe, expect, it, beforeEach, afterAll } from "vitest";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createDatabase } from "../db/index.js";
import { notes } from "../db/schema.js";
import { startCleanupJob } from "../cleanup.js";
import { LocalStorage } from "../storage/local.js";
import { serverEncrypt } from "@secret/crypto";
import type { AppDatabase } from "../db/index.js";

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
});

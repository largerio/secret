import { describe, expect, it, beforeEach, afterAll, vi } from "vitest";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createDatabase } from "../db/index.js";
import { notes } from "../db/schema.js";
import { startCleanupJob } from "../cleanup.js";
import { serverEncrypt } from "@secret/crypto";
import type { AppDatabase } from "../db/index.js";

const TEST_DB_PATH = "./data/cleanup-test.db";
const TEST_FILES_PATH = "./data/cleanup-test-files";
const TEST_SERVER_KEY = randomBytes(32);

let db: AppDatabase;

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
	db = createDatabase(TEST_DB_PATH);
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
		const past = new Date(Date.now() - 10_000);
		const { encrypted, iv } = serverEncrypt(Buffer.from("test"), TEST_SERVER_KEY);

		db.insert(notes)
			.values({
				id: "expired00001",
				encryptedData: encrypted,
				serverNonce: iv.toString("base64"),
				clientNonce: "test",
				hasPassword: false,
				burnAfterRead: false,
				fileCount: 0,
				filePath: null,
				expiresAt: past,
				createdAt: new Date(),
			})
			.run();

		const timer = startCleanupJob(db, 100);
		await new Promise((resolve) => setTimeout(resolve, 250));
		clearInterval(timer);

		const remaining = db.select().from(notes).all();
		expect(remaining).toHaveLength(0);
	});

	it("removes file on disk when cleaning expired note with file", async () => {
		const past = new Date(Date.now() - 10_000);
		const filePath = `${TEST_FILES_PATH}/expired-file`;
		writeFileSync(filePath, "encrypted-data");

		const { encrypted, iv } = serverEncrypt(Buffer.from("test"), TEST_SERVER_KEY);

		db.insert(notes)
			.values({
				id: "expiredfile1",
				encryptedData: encrypted,
				serverNonce: iv.toString("base64"),
				clientNonce: "test",
				hasPassword: false,
				burnAfterRead: false,
				fileCount: 1,
				filePath,
				expiresAt: past,
				createdAt: new Date(),
			})
			.run();

		const timer = startCleanupJob(db, 100);
		await new Promise((resolve) => setTimeout(resolve, 250));
		clearInterval(timer);

		expect(existsSync(filePath)).toBe(false);
	});

	it("does not remove non-expired notes", async () => {
		const future = new Date(Date.now() + 3_600_000);
		const { encrypted, iv } = serverEncrypt(Buffer.from("test"), TEST_SERVER_KEY);

		db.insert(notes)
			.values({
				id: "notexpired01",
				encryptedData: encrypted,
				serverNonce: iv.toString("base64"),
				clientNonce: "test",
				hasPassword: false,
				burnAfterRead: false,
				fileCount: 0,
				filePath: null,
				expiresAt: future,
				createdAt: new Date(),
			})
			.run();

		const timer = startCleanupJob(db, 100);
		await new Promise((resolve) => setTimeout(resolve, 250));
		clearInterval(timer);

		const remaining = db.select().from(notes).all();
		expect(remaining).toHaveLength(1);
	});
});

import { randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type AppDatabase, createDatabase } from "../db/index.js";
import { meta, notes } from "../db/schema.js";
import {
	assertServerKeyMatches,
	ServerKeyMismatchError,
	serverKeyFingerprint,
} from "../keyGuard.js";

const TEST_DB_PATH = "./data/keyguard-test.db";
const KEY_A = randomBytes(32);
const KEY_B = randomBytes(32);

let db: AppDatabase;
let sqlite: ReturnType<typeof createDatabase>["sqlite"];

function removeDbFiles(): void {
	for (const path of [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`]) {
		if (existsSync(path)) rmSync(path);
	}
}

function insertNote(id = "note-1"): void {
	db.insert(notes)
		.values({
			id,
			encryptedData: Buffer.from("x"),
			serverNonce: "nonce",
			clientNonce: "nonce",
			hasPassword: false,
			salt: null,
			deleteToken: "token",
			burnAfterRead: false,
			fileCount: 0,
			filePath: null,
			expiresAt: new Date(Date.now() + 60_000),
			maxReads: 1,
			createdAt: new Date(),
		})
		.run();
}

function storedFingerprint(): string | undefined {
	return db.select().from(meta).where(eq(meta.key, "server_key_fingerprint")).get()?.value;
}

beforeEach(() => {
	sqlite?.close();
	removeDbFiles();
	const created = createDatabase(TEST_DB_PATH);
	db = created.db;
	sqlite = created.sqlite;
});

afterAll(() => {
	sqlite?.close();
	removeDbFiles();
});

describe("serverKeyFingerprint", () => {
	it("is deterministic for a given key", () => {
		expect(serverKeyFingerprint(KEY_A)).toBe(serverKeyFingerprint(KEY_A));
	});

	it("differs between keys and never contains the key itself", () => {
		const fingerprint = serverKeyFingerprint(KEY_A);
		expect(fingerprint).not.toBe(serverKeyFingerprint(KEY_B));
		expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
		expect(fingerprint).not.toContain(KEY_A.toString("hex"));
	});
});

describe("assertServerKeyMatches", () => {
	it("adopts the key on a fresh database", () => {
		assertServerKeyMatches(db, KEY_A);
		expect(storedFingerprint()).toBe(serverKeyFingerprint(KEY_A));
	});

	it("accepts the same key on a later boot", () => {
		assertServerKeyMatches(db, KEY_A);
		expect(() => assertServerKeyMatches(db, KEY_A)).not.toThrow();
		expect(storedFingerprint()).toBe(serverKeyFingerprint(KEY_A));
	});

	it("adopts a database provisioned before this guard existed", () => {
		insertNote();
		// No fingerprint row: pre-existing deployments must keep booting.
		expect(() => assertServerKeyMatches(db, KEY_A)).not.toThrow();
		expect(storedFingerprint()).toBe(serverKeyFingerprint(KEY_A));
	});

	it("re-pins a new key while no notes exist", () => {
		assertServerKeyMatches(db, KEY_A);
		expect(() => assertServerKeyMatches(db, KEY_B)).not.toThrow();
		expect(storedFingerprint()).toBe(serverKeyFingerprint(KEY_B));
	});

	it("refuses to start when the key changed and notes exist", () => {
		assertServerKeyMatches(db, KEY_A);
		insertNote();

		let caught: unknown;
		try {
			assertServerKeyMatches(db, KEY_B);
		} catch (err) {
			caught = err;
		}

		expect(caught).toBeInstanceOf(ServerKeyMismatchError);
		const err = caught as ServerKeyMismatchError;
		expect(err.message).toContain("does not match the key this database was created with");
		expect(err.hint).toContain("cat /app/data/.encryption_key");
		expect(err.hint).toContain("ALLOW_SERVER_KEY_CHANGE");
		// The stored fingerprint must survive a refused boot.
		expect(storedFingerprint()).toBe(serverKeyFingerprint(KEY_A));
	});

	it("adopts the new key when the operator opts in, with a warning", () => {
		assertServerKeyMatches(db, KEY_A);
		insertNote();
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		expect(() => assertServerKeyMatches(db, KEY_B, { allowChange: true })).not.toThrow();

		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("existing notes are now unreadable"),
		);
		expect(storedFingerprint()).toBe(serverKeyFingerprint(KEY_B));
		warnSpy.mockRestore();
	});

	it("does not warn when opting in on an empty database", () => {
		assertServerKeyMatches(db, KEY_A);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		assertServerKeyMatches(db, KEY_B, { allowChange: true });

		expect(warnSpy).not.toHaveBeenCalled();
		warnSpy.mockRestore();
	});
});

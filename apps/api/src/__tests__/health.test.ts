import { existsSync, rmSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type AppDatabase, createDatabase } from "../db/index.js";
import { createHealthCheck } from "../health.js";
import type { StorageBackend } from "../storage/index.js";

const TEST_DB_PATH = "./data/health-test.db";

let db: AppDatabase;
let sqlite: ReturnType<typeof createDatabase>["sqlite"];

function removeDbFiles(): void {
	for (const path of [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`]) {
		if (existsSync(path)) rmSync(path);
	}
}

/** One test closes the handle itself to simulate an unusable database. */
function closeQuietly(): void {
	try {
		sqlite?.close();
	} catch {
		/* already closed */
	}
}

function makeStorage(overrides: Partial<StorageBackend> = {}): StorageBackend {
	return {
		save: vi.fn(),
		read: vi.fn(),
		delete: vi.fn(),
		saveChunk: vi.fn(),
		readChunk: vi.fn(),
		deleteChunks: vi.fn(),
		probe: vi.fn(() => Promise.resolve()),
		...overrides,
	} as StorageBackend;
}

beforeEach(() => {
	closeQuietly();
	removeDbFiles();
	const created = createDatabase(TEST_DB_PATH);
	db = created.db;
	sqlite = created.sqlite;
});

afterAll(() => {
	closeQuietly();
	removeDbFiles();
});

describe("createHealthCheck", () => {
	it("reports ok when both probes succeed", async () => {
		const check = createHealthCheck(db, makeStorage());
		expect(await check()).toEqual({
			status: "ok",
			checks: { database: "ok", storage: "ok" },
			storage: { usedBytes: 0, quotaBytes: null },
		});
	});

	it("reports the configured quota and current usage", async () => {
		sqlite
			.prepare(
				`INSERT INTO notes (id, encrypted_data, server_nonce, client_nonce, delete_token, expires_at, created_at, size_bytes)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run("quota-note", Buffer.alloc(0), "iv", "nonce", "token", 9999999999999, 1, 1234);

		const check = createHealthCheck(db, makeStorage(), { quotaBytes: 5000 });
		const report = await check();

		expect(report.storage).toEqual({ usedBytes: 1234, quotaBytes: 5000 });
	});

	it("treats a backend without a probe as healthy", async () => {
		const storage = makeStorage();
		delete (storage as { probe?: unknown }).probe;

		expect((await createHealthCheck(db, storage)()).status).toBe("ok");
	});

	it("reports degraded when the storage probe rejects", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const storage = makeStorage({ probe: vi.fn(() => Promise.reject(new Error("no bucket"))) });

		expect(await createHealthCheck(db, storage)()).toEqual({
			status: "degraded",
			checks: { database: "ok", storage: "error" },
			storage: { usedBytes: 0, quotaBytes: null },
		});
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining('"msg":"storage probe failed","detail":"no bucket"'),
		);
		errorSpy.mockRestore();
	});

	it("logs a non-Error rejection verbatim", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const storage = makeStorage({ probe: vi.fn(() => Promise.reject("plain string")) });

		await createHealthCheck(db, storage)();

		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining('"msg":"storage probe failed","detail":"plain string"'),
		);
		errorSpy.mockRestore();
	});

	it("reports degraded when the database is unusable", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const check = createHealthCheck(db, makeStorage());
		sqlite.close();

		const report = await check();

		expect(report.status).toBe("degraded");
		expect(report.checks.database).toBe("error");
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('"msg":"database probe failed"'));
		errorSpy.mockRestore();
	});

	it("logs a non-Error database failure verbatim", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const failingDb = {
			get: () => {
				throw "db exploded";
			},
		} as unknown as AppDatabase;

		await createHealthCheck(failingDb, makeStorage())();

		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining('"msg":"database probe failed","detail":"db exploded"'),
		);
		errorSpy.mockRestore();
	});

	it("serves the cached report within the TTL", async () => {
		const storage = makeStorage();
		let clock = 1_000;
		const check = createHealthCheck(db, storage, { ttlMs: 10_000, now: () => clock });

		await check();
		clock += 9_999;
		await check();

		expect(storage.probe).toHaveBeenCalledTimes(1);
	});

	it("re-probes once the TTL expires", async () => {
		const storage = makeStorage();
		let clock = 1_000;
		const check = createHealthCheck(db, storage, { ttlMs: 10_000, now: () => clock });

		await check();
		clock += 10_001;
		await check();

		expect(storage.probe).toHaveBeenCalledTimes(2);
	});

	it("collapses concurrent probes into a single round", async () => {
		let resolveProbe: () => void = () => undefined;
		const storage = makeStorage({
			probe: vi.fn(
				() =>
					new Promise<void>((resolve) => {
						resolveProbe = resolve;
					}),
			),
		});
		const check = createHealthCheck(db, storage);

		const both = Promise.all([check(), check()]);
		resolveProbe();
		const [first, second] = await both;

		expect(storage.probe).toHaveBeenCalledTimes(1);
		expect(first).toEqual(second);
	});
});

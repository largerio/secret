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
		});
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
		});
		expect(errorSpy).toHaveBeenCalledWith("[health] storage probe failed:", "no bucket");
		errorSpy.mockRestore();
	});

	it("logs a non-Error rejection verbatim", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const storage = makeStorage({ probe: vi.fn(() => Promise.reject("plain string")) });

		await createHealthCheck(db, storage)();

		expect(errorSpy).toHaveBeenCalledWith("[health] storage probe failed:", "plain string");
		errorSpy.mockRestore();
	});

	it("reports degraded when the database is unusable", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const check = createHealthCheck(db, makeStorage());
		sqlite.close();

		const report = await check();

		expect(report.status).toBe("degraded");
		expect(report.checks.database).toBe("error");
		expect(errorSpy).toHaveBeenCalledWith("[health] database probe failed:", expect.any(String));
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

		expect(errorSpy).toHaveBeenCalledWith("[health] database probe failed:", "db exploded");
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

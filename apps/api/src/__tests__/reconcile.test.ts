import { existsSync, mkdirSync, rmSync } from "node:fs";
import { utimes } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppDatabase } from "../db/index.js";
import { createDatabase } from "../db/index.js";
import { meta, notes, pendingDeletions, uploads } from "../db/schema.js";
import {
	getInstanceId,
	RECONCILE_FIRST_RUN_MS,
	RECONCILE_INTERVAL_MS,
	reconcileStorage,
	startReconcileJob,
} from "../reconcile.js";
import type { StoredNote } from "../storage/index.js";
import { LocalStorage } from "../storage/local.js";
import { stubStorage } from "./storageDoubles.js";

const TEST_DB_PATH = "./data/reconcile-test.db";
const TEST_FILES_PATH = "./data/reconcile-test-files";
const TWO_DAYS_AGO = new Date(Date.now() - 2 * 24 * 60 * 60_000);

let db: AppDatabase;
let storage: LocalStorage;

function removeTestFiles(): void {
	rmSync(TEST_DB_PATH, { force: true });
	rmSync(`${TEST_DB_PATH}-wal`, { force: true });
	rmSync(`${TEST_DB_PATH}-shm`, { force: true });
	rmSync(TEST_FILES_PATH, { recursive: true, force: true });
}

beforeEach(() => {
	removeTestFiles();
	mkdirSync("./data", { recursive: true });
	db = createDatabase(TEST_DB_PATH).db;
	storage = new LocalStorage(TEST_FILES_PATH);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

afterAll(() => {
	removeTestFiles();
});

/** A file note written two days ago, past the sweep's grace period. */
async function storeOld(noteId: string): Promise<string> {
	const path = await storage.save(noteId, Buffer.from("payload"));
	await utimes(path, TWO_DAYS_AGO, TWO_DAYS_AGO);
	return path;
}

function insertNote(id: string): void {
	db.insert(notes)
		.values({
			id,
			encryptedData: Buffer.alloc(0),
			serverNonce: "iv",
			clientNonce: "nonce",
			deleteToken: "token",
			fileCount: 1,
			filePath: join(TEST_FILES_PATH, id),
			expiresAt: new Date(Date.now() + 3_600_000),
			createdAt: new Date(),
		})
		.run();
}

describe("getInstanceId", () => {
	it("creates the id once and returns it from then on", () => {
		const first = getInstanceId(db);

		expect(first).toMatch(/^[A-Za-z0-9_-]{21}$/);
		expect(getInstanceId(db)).toBe(first);
		expect(db.select().from(meta).all()).toEqual([{ key: "instance_id", value: first }]);
	});
});

describe("reconcileStorage", () => {
	it("purges an old object no note points to", async () => {
		const orphan = await storeOld("orphanNote01");

		const result = await reconcileStorage(db, storage);

		expect(result).toEqual({ status: "done", scanned: 1, purged: 1, failed: 0 });
		expect(existsSync(orphan)).toBe(false);
	});

	it("keeps an object written within the grace period", async () => {
		const recent = await storage.save("recentNote01", Buffer.from("payload"));

		const result = await reconcileStorage(db, storage);

		expect(result).toMatchObject({ scanned: 1, purged: 0 });
		expect(existsSync(recent)).toBe(true);
	});

	it("keeps what a note, an upload session or a queued purge still owns", async () => {
		const kept = [
			await storeOld("ownedByNote1"),
			await storeOld("ownedByUpld1"),
			await storeOld("ownedByPurge"),
		];
		insertNote("ownedByNote1");
		db.insert(uploads)
			.values({
				id: "upload000001",
				metadata: "{}",
				chunkCount: 1,
				noteId: "ownedByUpld1",
				deleteToken: "token",
				createdAt: new Date(),
				expiresAt: new Date(Date.now() + 3_600_000),
			})
			.run();
		db.insert(pendingDeletions)
			.values({
				noteId: "ownedByPurge",
				attempts: 0,
				nextRetryAt: new Date(Date.now() + 60_000),
				createdAt: new Date(),
			})
			.run();

		const result = await reconcileStorage(db, storage);

		expect(result).toEqual({ status: "done", scanned: 3, purged: 0, failed: 0 });
		for (const path of kept) {
			expect(existsSync(path)).toBe(true);
		}
	});

	it("claims the storage for this database", async () => {
		await reconcileStorage(db, storage);

		expect(await storage.listClaims()).toEqual([getInstanceId(db)]);
	});

	it("touches nothing when another database has claimed the storage, and claims it too", async () => {
		const orphan = await storeOld("orphanNote02");
		await storage.claim("other-instance");

		const result = await reconcileStorage(db, storage);

		expect(result).toEqual({ status: "skipped", otherInstances: ["other-instance"] });
		expect(existsSync(orphan)).toBe(true);
		// So that the other instance stops sweeping as well.
		expect((await storage.listClaims()).sort()).toEqual(
			[getInstanceId(db), "other-instance"].sort(),
		);
	});

	it("counts a purge that fails and moves on to the next orphan", async () => {
		const old = new Date(Date.now() - 2 * 24 * 60 * 60_000);
		const failing = stubStorage({
			list: async function* (): AsyncIterable<StoredNote> {
				yield { noteId: "failingNote1", lastModified: old };
				yield { noteId: "purgedNote01", lastModified: old };
			},
			purge: vi
				.fn()
				.mockRejectedValueOnce(new Error("access denied"))
				.mockResolvedValueOnce(undefined)
				.mockRejectedValueOnce("plain failure")
				.mockResolvedValueOnce(undefined),
		});
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const first = await reconcileStorage(db, failing);
		const second = await reconcileStorage(db, failing);

		expect(first).toEqual({ status: "done", scanned: 2, purged: 1, failed: 1 });
		expect(second).toEqual({ status: "done", scanned: 2, purged: 1, failed: 1 });
		const logged = consoleSpy.mock.calls.map((call) => String(call[0]));
		expect(logged[0]).toContain(
			'"msg":"storage sweep could not purge an orphan","detail":"access denied"',
		);
		expect(logged[1]).toContain('"detail":"plain failure"');
		expect(logged.join("\n")).not.toContain("failingNote1");
	});
});

describe("startReconcileJob", () => {
	const old = new Date(Date.now() - 2 * 24 * 60 * 60_000);

	function orphanStorage() {
		return stubStorage({
			list: vi.fn(async function* (): AsyncIterable<StoredNote> {
				yield { noteId: "orphanNote03", lastModified: old };
			}),
		});
	}

	it("sweeps shortly after boot, then once per interval", async () => {
		vi.useFakeTimers();
		const swept = orphanStorage();
		const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		const job = startReconcileJob(db, swept);
		await vi.advanceTimersByTimeAsync(RECONCILE_FIRST_RUN_MS - 1);
		expect(swept.list).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		expect(swept.list).toHaveBeenCalledTimes(1);
		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining('"msg":"storage sweep finished","scanned":1,"purged":1,"failed":0'),
		);

		await vi.advanceTimersByTimeAsync(RECONCILE_INTERVAL_MS);
		expect(swept.list).toHaveBeenCalledTimes(2);
		job.stop();
	});

	it("stays quiet when there is nothing to purge", async () => {
		vi.useFakeTimers();
		const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		const job = startReconcileJob(db, stubStorage());
		await vi.advanceTimersByTimeAsync(RECONCILE_FIRST_RUN_MS);
		job.stop();

		expect(consoleSpy).not.toHaveBeenCalled();
	});

	it("warns when the storage is claimed by another database", async () => {
		vi.useFakeTimers();
		const shared = stubStorage({ listClaims: vi.fn().mockResolvedValue(["someone-else"]) });
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const job = startReconcileJob(db, shared);
		await vi.advanceTimersByTimeAsync(RECONCILE_FIRST_RUN_MS);
		job.stop();

		expect(shared.list).not.toHaveBeenCalled();
		const logged = String(consoleSpy.mock.calls[0]?.[0]);
		expect(logged).toContain('"level":"warn"');
		expect(logged).toContain(
			'"msg":"storage sweep skipped: another database has claimed this storage"',
		);
		expect(logged).toContain('"instances":["someone-else"]');
		expect(logged).toContain("instances/<id>");
	});

	it("logs a failed sweep and keeps the schedule", async () => {
		vi.useFakeTimers();
		const broken = stubStorage({
			claim: vi
				.fn()
				.mockRejectedValueOnce(new Error("bucket unreachable"))
				.mockRejectedValueOnce("plain failure"),
		});
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const job = startReconcileJob(db, broken);
		await vi.advanceTimersByTimeAsync(RECONCILE_FIRST_RUN_MS);
		await vi.advanceTimersByTimeAsync(RECONCILE_INTERVAL_MS);
		job.stop();

		const logged = consoleSpy.mock.calls.map((call) => String(call[0]));
		expect(logged[0]).toContain('"msg":"storage sweep failed","detail":"bucket unreachable"');
		expect(logged[1]).toContain('"detail":"plain failure"');
	});

	it("runs no more sweeps once stopped", async () => {
		vi.useFakeTimers();
		const swept = orphanStorage();
		vi.spyOn(console, "log").mockImplementation(() => {});

		const job = startReconcileJob(db, swept);
		job.stop();
		await vi.advanceTimersByTimeAsync(RECONCILE_FIRST_RUN_MS + RECONCILE_INTERVAL_MS);

		expect(swept.list).not.toHaveBeenCalled();
	});

	it("does not reschedule when stopped during a sweep", async () => {
		vi.useFakeTimers();
		let release: () => void = () => {};
		const slow = stubStorage({
			claim: vi.fn(
				() =>
					new Promise<void>((resolve) => {
						release = resolve;
					}),
			),
		});

		const job = startReconcileJob(db, slow);
		await vi.advanceTimersByTimeAsync(RECONCILE_FIRST_RUN_MS);
		job.stop();
		release();
		await vi.advanceTimersByTimeAsync(RECONCILE_INTERVAL_MS);

		expect(slow.claim).toHaveBeenCalledTimes(1);
	});
});

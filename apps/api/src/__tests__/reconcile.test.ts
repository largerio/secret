import { existsSync, mkdirSync, rmSync } from "node:fs";
import { utimes } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppDatabase } from "../db/index.js";
import { createDatabase } from "../db/index.js";
import { meta, notes, pendingDeletions, uploads } from "../db/schema.js";
import {
	claimStorage,
	getInstance,
	RECONCILE_FIRST_RUN_MS,
	RECONCILE_GRACE_MS,
	RECONCILE_INTERVAL_MS,
	RECONCILE_TRIAL_MS,
	reconcileStorage,
	startReconcileJob,
} from "../reconcile.js";
import type { StoredNote } from "../storage/index.js";
import { LocalStorage } from "../storage/local.js";
import { stubStorage } from "./storageDoubles.js";

const TEST_DB_PATH = "./data/reconcile-test.db";
const TEST_FILES_PATH = "./data/reconcile-test-files";
const DAY_MS = 24 * 60 * 60_000;
const TWO_DAYS_AGO = new Date(Date.now() - 2 * DAY_MS);

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

/** This database claimed its storage two days ago: past the sweep's trial day. */
function claimedTwoDaysAgo(): void {
	getInstance(db);
	db.update(meta)
		.set({ value: String(TWO_DAYS_AGO.getTime()) })
		.where(eq(meta.key, "instance_since"))
		.run();
}

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

/** A backend listing the given notes; claims and purges succeed. */
function listing(...stored: StoredNote[]) {
	return stubStorage({
		list: vi.fn(async function* (): AsyncIterable<StoredNote> {
			yield* stored;
		}),
	});
}

describe("getInstance", () => {
	it("creates the id and its date once, and returns them from then on", () => {
		const before = Date.now();
		const first = getInstance(db);

		expect(first.id).toMatch(/^[A-Za-z0-9_-]{21}$/);
		expect(first.since.getTime()).toBeGreaterThanOrEqual(before);
		expect(first.since.getTime()).toBeLessThanOrEqual(Date.now());
		expect(getInstance(db)).toEqual(first);
		expect(db.select().from(meta).all()).toHaveLength(2);
	});

	it("starts over when only half of it was recorded", () => {
		db.insert(meta).values({ key: "instance_id", value: "half-written" }).run();

		const instance = getInstance(db);

		expect(instance.id).not.toBe("half-written");
		expect(getInstance(db)).toEqual(instance);
	});
});

describe("claimStorage", () => {
	it("claims the storage for this database", async () => {
		await claimStorage(db, storage);

		expect(await storage.listClaims()).toEqual([getInstance(db).id]);
	});

	it("warns and carries on when the claim cannot be written", async () => {
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const failing = stubStorage({
			claim: vi.fn().mockRejectedValue(Object.assign(new Error("/data/x"), { code: "EACCES" })),
		});

		await expect(claimStorage(db, failing)).resolves.toBeUndefined();

		const logged = String(consoleSpy.mock.calls[0]?.[0]);
		expect(logged).toContain('"msg":"could not claim the storage","detail":"EACCES"');
		expect(logged).not.toContain("/data/x");
	});
});

describe("reconcileStorage", () => {
	it("purges an old object no note points to", async () => {
		claimedTwoDaysAgo();
		const orphan = await storeOld("orphanNote01");

		const result = await reconcileStorage(db, storage);

		expect(result).toEqual({ status: "done", scanned: 1, purged: 1, failed: 0 });
		expect(existsSync(orphan)).toBe(false);
	});

	it("keeps an object until it is a full grace period old", async () => {
		claimedTwoDaysAgo();
		const now = new Date();
		const swept = listing(
			{ noteId: "justOldEnuf1", lastModified: new Date(now.getTime() - RECONCILE_GRACE_MS) },
			{ noteId: "notYetOld001", lastModified: new Date(now.getTime() - RECONCILE_GRACE_MS + 1) },
		);

		const result = await reconcileStorage(db, swept, now);

		expect(result).toEqual({ status: "done", scanned: 2, purged: 1, failed: 0 });
		expect(swept.purge).toHaveBeenCalledExactlyOnceWith("justOldEnuf1");
	});

	it("keeps what a note, an upload session or a queued purge still owns", async () => {
		claimedTwoDaysAgo();
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

	it("only counts orphans during the first day after the claim", async () => {
		const orphan = await storeOld("orphanNote02");
		const since = getInstance(db).since.getTime();

		const firstDay = await reconcileStorage(db, storage, new Date(since + RECONCILE_TRIAL_MS - 1));
		expect(firstDay).toEqual({ status: "trial", scanned: 1, orphans: 1 });
		expect(existsSync(orphan)).toBe(true);

		const dayAfter = await reconcileStorage(db, storage, new Date(since + RECONCILE_TRIAL_MS));
		expect(dayAfter).toEqual({ status: "done", scanned: 1, purged: 1, failed: 0 });
		expect(existsSync(orphan)).toBe(false);
	});

	it("claims the storage before reading the claims, so two first sweeps see each other", async () => {
		const order: string[] = [];
		const tracked = stubStorage({
			claim: vi.fn(async () => {
				order.push("claim");
			}),
			listClaims: vi.fn(async () => {
				order.push("listClaims");
				return [];
			}),
		});

		await reconcileStorage(db, tracked);

		expect(order).toEqual(["claim", "listClaims"]);
		expect(tracked.claim).toHaveBeenCalledWith(getInstance(db).id);
	});

	it("touches nothing when another database has claimed the storage, and claims it too", async () => {
		claimedTwoDaysAgo();
		const orphan = await storeOld("orphanNote03");
		await storage.claim("other-instance");

		const result = await reconcileStorage(db, storage);

		expect(result).toEqual({ status: "skipped", otherInstances: ["other-instance"] });
		expect(existsSync(orphan)).toBe(true);
		// So that the other instance stops sweeping as well.
		expect((await storage.listClaims()).sort()).toEqual(
			[getInstance(db).id, "other-instance"].sort(),
		);
	});

	it("counts a purge that fails, moves on, and never logs a failure's message", async () => {
		claimedTwoDaysAgo();
		const swept = listing(
			{ noteId: "failingNote1", lastModified: TWO_DAYS_AGO },
			{ noteId: "purgedNote01", lastModified: TWO_DAYS_AGO },
		);
		vi.mocked(swept.purge)
			.mockRejectedValueOnce(new Error("rmdir /data/failingNote1"))
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce("plain failure")
			.mockResolvedValueOnce(undefined);
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const first = await reconcileStorage(db, swept);
		const second = await reconcileStorage(db, swept);

		expect(first).toEqual({ status: "done", scanned: 2, purged: 1, failed: 1 });
		expect(second).toEqual({ status: "done", scanned: 2, purged: 1, failed: 1 });
		const logged = consoleSpy.mock.calls.map((call) => String(call[0]));
		expect(logged[0]).toContain('"msg":"storage sweep could not purge an orphan","detail":"Error"');
		expect(logged[1]).toContain('"detail":"string"');
		expect(logged.join("\n")).not.toContain("failingNote1");
	});
});

describe("startReconcileJob", () => {
	function orphanStorage() {
		return listing({ noteId: "orphanNote04", lastModified: TWO_DAYS_AGO });
	}

	it("sweeps shortly after boot, then once per interval", async () => {
		vi.useFakeTimers();
		claimedTwoDaysAgo();
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
		claimedTwoDaysAgo();
		const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		const job = startReconcileJob(db, stubStorage());
		await vi.advanceTimersByTimeAsync(RECONCILE_FIRST_RUN_MS);
		job.stop();

		expect(consoleSpy).not.toHaveBeenCalled();
	});

	it("warns, on its trial day, about the orphans it will delete", async () => {
		vi.useFakeTimers();
		const swept = orphanStorage();
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const job = startReconcileJob(db, swept);
		await vi.advanceTimersByTimeAsync(RECONCILE_FIRST_RUN_MS);
		job.stop();

		expect(swept.purge).not.toHaveBeenCalled();
		const logged = String(consoleSpy.mock.calls[0]?.[0]);
		expect(logged).toContain('"level":"warn"');
		expect(logged).toContain(
			'"msg":"storage sweep on trial: nothing deleted yet","scanned":1,"orphans":1',
		);
	});

	it("stays quiet on its trial day when nothing is orphaned", async () => {
		vi.useFakeTimers();
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

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

	it("logs a failed sweep without its message, and keeps the schedule", async () => {
		vi.useFakeTimers();
		const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
		const broken = stubStorage({
			claim: vi.fn().mockRejectedValueOnce(refused).mockRejectedValueOnce("plain failure"),
		});
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const job = startReconcileJob(db, broken);
		await vi.advanceTimersByTimeAsync(RECONCILE_FIRST_RUN_MS);
		await vi.advanceTimersByTimeAsync(RECONCILE_INTERVAL_MS);
		job.stop();

		const logged = consoleSpy.mock.calls.map((call) => String(call[0]));
		expect(logged[0]).toContain('"msg":"storage sweep failed","detail":"ECONNREFUSED"');
		expect(logged[1]).toContain('"detail":"string"');
	});

	it("tells onSweep how each run ended", async () => {
		vi.useFakeTimers();
		claimedTwoDaysAgo();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		const swept = orphanStorage();
		vi.mocked(swept.claim)
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error("down"));
		const onSweep = vi.fn();

		const job = startReconcileJob(db, swept, onSweep);
		await vi.advanceTimersByTimeAsync(RECONCILE_FIRST_RUN_MS);
		await vi.advanceTimersByTimeAsync(RECONCILE_INTERVAL_MS);
		job.stop();

		expect(onSweep.mock.calls).toEqual([
			[{ status: "done", scanned: 1, purged: 1, failed: 0 }],
			[{ status: "failed" }],
		]);
	});

	it("runs no more sweeps once stopped", async () => {
		vi.useFakeTimers();
		const swept = orphanStorage();

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

describe("schedule", () => {
	it("waits a day before purging, a day after claiming, and sweeps daily", () => {
		expect(RECONCILE_GRACE_MS).toBe(DAY_MS);
		expect(RECONCILE_TRIAL_MS).toBe(DAY_MS);
		expect(RECONCILE_INTERVAL_MS).toBe(DAY_MS);
		expect(RECONCILE_FIRST_RUN_MS).toBe(10 * 60_000);
	});
});

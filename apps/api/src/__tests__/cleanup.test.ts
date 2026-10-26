import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
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
let sqlite: DatabaseSync;
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

function pendingNoteIds(): string[] {
	return db
		.select()
		.from(pendingDeletions)
		.all()
		.map((row) => row.noteId);
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
	({ db, sqlite } = createDatabase(TEST_DB_PATH));
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
		expect(pendingNoteIds()).toEqual(["crashed00001"]);
	});

	it("keeps an expired note whose purge cannot be queued: both writes are one transaction", async () => {
		sqlite.exec(`CREATE TRIGGER outbox_full BEFORE INSERT ON pending_deletions
			BEGIN SELECT RAISE(ABORT, 'outbox full'); END`);
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		insertNote("atomic000001", { fileCount: 1, filePath: "/data/files/atomic000001" });

		await runCleanup(db, stubStorage());

		expect(
			db
				.select()
				.from(notes)
				.all()
				.map((note) => note.id),
		).toEqual(["atomic000001"]);
		const logged = String(consoleSpy.mock.calls[0]?.[0]);
		expect(logged).toContain('"msg":"cleanup job failed"');
		// The failed query quoted the note id in its message.
		expect(logged).not.toContain("atomic000001");
	});

	it("keeps an expired upload session whose purge cannot be queued", async () => {
		sqlite.exec(`CREATE TRIGGER outbox_full BEFORE INSERT ON pending_deletions
			BEGIN SELECT RAISE(ABORT, 'outbox full'); END`);
		vi.spyOn(console, "error").mockImplementation(() => {});
		insertUpload("upload000009", "uploadnote09", new Date(Date.now() - 10_000));

		await runCleanup(db, stubStorage());

		expect(
			db
				.select()
				.from(uploads)
				.all()
				.map((upload) => upload.id),
		).toEqual(["upload000009"]);
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
		expect(pendingNoteIds()).toEqual(["uploadnote03"]);
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
			expect.stringContaining('"msg":"cleanup job failed","detail":"Error"'),
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
			expect.stringContaining('"msg":"cleanup job failed","detail":"string"'),
		);
	});
});

describe("runCleanup in batches", () => {
	function noteIds(): string[] {
		return db
			.select()
			.from(notes)
			.all()
			.map((note) => note.id)
			.sort();
	}

	// Expired, oldest first: batches take them in this order.
	function insertExpiredFileNotes(count: number): void {
		for (let i = 1; i <= count; i++) {
			const id = `batched0000${String(i)}`;
			insertNote(id, {
				fileCount: 1,
				filePath: `/data/files/${id}`,
				expiresAt: new Date(Date.now() - 60_000 + i * 1000),
			});
		}
	}

	it("commits and purges each batch before taking the next", async () => {
		const notesLeftAtPurge: Record<string, number> = {};
		const tracked = stubStorage({
			purge: vi.fn(async (noteId: string) => {
				notesLeftAtPurge[noteId] = db.select().from(notes).all().length;
			}),
		});
		const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		insertExpiredFileNotes(5);
		insertNote("stillgood001", { expiresAt: new Date(Date.now() + 3_600_000) });

		await runCleanup(db, tracked, 2);

		// Two, two, then a short batch of one ends the pass.
		expect(notesLeftAtPurge).toEqual({
			batched00001: 4,
			batched00002: 4,
			batched00003: 2,
			batched00004: 2,
			batched00005: 1,
		});
		expect(noteIds()).toEqual(["stillgood001"]);
		expect(db.select().from(pendingDeletions).all()).toHaveLength(0);
		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining('"msg":"expired notes deleted","count":5'),
		);
	});

	it("stops on an empty batch when the last full one took the rest", async () => {
		const tracked = stubStorage();
		vi.spyOn(console, "log").mockImplementation(() => {});
		insertExpiredFileNotes(4);

		await runCleanup(db, tracked, 2);

		expect(noteIds()).toEqual([]);
		expect(tracked.purge).toHaveBeenCalledTimes(4);
	});

	it("keeps the batches committed before a failure, and rolls the failing one back whole", async () => {
		// The fourth note's purge cannot be queued: its batch, the second, fails
		// after deleting both its notes and queuing the third one's purge.
		sqlite.exec(`CREATE TRIGGER outbox_full BEFORE INSERT ON pending_deletions
			WHEN NEW.note_id = 'batched00004'
			BEGIN SELECT RAISE(ABORT, 'outbox full'); END`);
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
		const tracked = stubStorage();
		insertExpiredFileNotes(5);

		await runCleanup(db, tracked, 2);

		expect(tracked.purge).toHaveBeenCalledTimes(2);
		expect(tracked.purge).toHaveBeenCalledWith("batched00001");
		expect(tracked.purge).toHaveBeenCalledWith("batched00002");
		// Every note still there has no purge queued, every one gone was purged.
		expect(noteIds()).toEqual(["batched00003", "batched00004", "batched00005"]);
		expect(db.select().from(pendingDeletions).all()).toHaveLength(0);
		expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('"msg":"cleanup job failed"'));
	});

	it("deletes expired upload sessions in batches too", async () => {
		const tracked = stubStorage();
		vi.spyOn(console, "log").mockImplementation(() => {});
		for (let i = 1; i <= 3; i++) {
			insertUpload(
				`upload00000${String(i)}`,
				`uploadnote0${String(i)}`,
				new Date(Date.now() - 60_000 + i * 1000),
			);
		}

		await runCleanup(db, tracked, 2);

		expect(db.select().from(uploads).all()).toHaveLength(0);
		expect(tracked.purge).toHaveBeenCalledTimes(3);
		expect(db.select().from(pendingDeletions).all()).toHaveLength(0);
	});

	it("lets other work run between batches", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		for (let i = 1; i <= 3; i++) {
			insertNote(`inline00000${String(i)}`);
		}
		// Inline notes have nothing to purge: without a turn of the event loop
		// between batches, the whole pass would run before this callback.
		let notesLeftWhenRun: number | undefined;
		setImmediate(() => {
			notesLeftWhenRun = db.select().from(notes).all().length;
		});

		await runCleanup(db, stubStorage(), 1);

		expect(notesLeftWhenRun).toBe(2);
		expect(noteIds()).toEqual([]);
	});

	it("deletes up to 200 rows per transaction by default", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const transaction = vi.spyOn(db, "transaction");
		const expiresAt = new Date(Date.now() - 10_000);
		db.transaction(() => {
			for (let i = 0; i < 450; i++) {
				insertNote(`bulk${String(i).padStart(8, "0")}`, { expiresAt });
			}
		});
		transaction.mockClear();

		await runCleanup(db, stubStorage());

		expect(noteIds()).toEqual([]);
		// 200 + 200 + 50 notes, then one empty batch of upload sessions.
		expect(transaction).toHaveBeenCalledTimes(4);
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

	it("skips a tick while the previous pass is still running", async () => {
		vi.useFakeTimers();
		let release: () => void = () => {};
		const slow = stubStorage({
			purge: vi.fn(
				() =>
					new Promise<void>((resolve) => {
						release = resolve;
					}),
			),
		});
		vi.spyOn(console, "log").mockImplementation(() => {});
		insertNote("slowpurge001", { fileCount: 1, filePath: "/data/files/slowpurge001" });

		const timer = startCleanupJob(db, slow, 100);
		await vi.advanceTimersByTimeAsync(100);
		insertNote("slowpurge002", { fileCount: 1, filePath: "/data/files/slowpurge002" });
		await vi.advanceTimersByTimeAsync(300);
		expect(slow.purge).toHaveBeenCalledTimes(1);

		release();
		await vi.advanceTimersByTimeAsync(100);
		clearInterval(timer);
		expect(slow.purge).toHaveBeenCalledWith("slowpurge002");
	});
});

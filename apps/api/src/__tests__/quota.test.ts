import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
// Extends Zod with `.openapi()` before `@largerio/secret-shared` builds its
// schemas, as the routes expect (the production entry point does the same).
import "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../app.js";
import type { AppDatabase } from "../db/index.js";
import { createDatabase } from "../db/index.js";
import { notes, uploadChunks, uploads } from "../db/schema.js";
import { assertStorageQuota, getStorageUsedBytes } from "../quota.js";
import type { StorageBackend } from "../storage/index.js";
import { LocalStorage } from "../storage/local.js";
import { overrideStorage } from "./storageDoubles.js";
import { createTestApp } from "./testApp.js";

vi.mock("../routes/cap.js", () => ({
	cap: {
		validateToken: vi.fn((token: string) =>
			Promise.resolve({ success: token === "valid-cap-token" }),
		),
	},
	createCapRoutes: () => new Hono(),
}));

const TEST_DB_PATH = "./data/test-quota.db";
const TEST_FILES_PATH = "./data/test-quota-files";
const TEST_SERVER_KEY = randomBytes(32);

// AES-256-GCM overhead per stored payload: 16-byte auth tag for inline blobs,
// plus the 12-byte IV prepended to chunk files.
const TAG_BYTES = 16;
const CHUNK_OVERHEAD = 28;

let db: AppDatabase;
let sqlite: ReturnType<typeof createDatabase>["sqlite"];

const stops: Array<() => void> = [];

/** The real application, with STORAGE_QUOTA_BYTES set. */
function createQuotaApp(
	database: AppDatabase,
	quotaBytes: number,
	storage: StorageBackend = new LocalStorage(TEST_FILES_PATH),
): Hono<AppEnv> {
	const { app, stop } = createTestApp({
		db: database,
		serverKey: TEST_SERVER_KEY,
		storage,
		env: { STORAGE_QUOTA_BYTES: String(quotaBytes) },
	});
	stops.push(stop);
	return app;
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
	return { "X-Cap-Token": "valid-cap-token", ...extra };
}

function createBody(payloadBytes: number): string {
	return JSON.stringify({
		encryptedData: Buffer.alloc(payloadBytes, 7).toString("base64"),
		clientNonce: Buffer.from("test-nonce-24-bytes!!!!").toString("base64"),
		hasPassword: false,
		expiresIn: 3600,
		maxReads: 0,
		fileCount: 0,
	});
}

async function initUpload(
	app: ReturnType<typeof createQuotaApp>,
	chunkCount = 1,
): Promise<{ status: number; uploadId: string }> {
	const res = await app.request("/api/v1/notes/upload/init", {
		method: "POST",
		headers: authHeaders({ "Content-Type": "application/json" }),
		body: JSON.stringify({
			streamHeader: Buffer.from("test-header-24-bytes!!!").toString("base64"),
			clientNonce: Buffer.from("test-nonce-24-bytes!!!!").toString("base64"),
			hasPassword: false,
			expiresIn: 3600,
			maxReads: 0,
			fileCount: 1,
			chunkCount,
		}),
	});
	const body = (await res.json()) as { uploadId?: string };
	return { status: res.status, uploadId: body.uploadId ?? "" };
}

async function putChunk(
	app: ReturnType<typeof createQuotaApp>,
	uploadId: string,
	index: number,
	payloadBytes: number,
	fill = 1,
): Promise<number> {
	const chunk = Buffer.alloc(payloadBytes, fill);
	const res = await app.request(`/api/v1/notes/upload/${uploadId}/chunks/${String(index)}`, {
		method: "PUT",
		headers: {
			"Content-Type": "application/octet-stream",
			"X-Chunk-Hash": createHash("sha256").update(chunk).digest("hex"),
		},
		body: new Uint8Array(chunk) as BodyInit,
	});
	return res.status;
}

beforeAll(() => {
	mkdirSync("./data", { recursive: true });
	mkdirSync(TEST_FILES_PATH, { recursive: true });
});

beforeEach(() => {
	try {
		sqlite?.close();
	} catch {
		/* already closed */
	}
	rmSync(TEST_DB_PATH, { force: true });
	rmSync(`${TEST_DB_PATH}-wal`, { force: true });
	rmSync(`${TEST_DB_PATH}-shm`, { force: true });
	const created = createDatabase(TEST_DB_PATH);
	db = created.db;
	sqlite = created.sqlite;
});

afterAll(() => {
	for (const stop of stops) stop();
	try {
		sqlite?.close();
	} catch {
		/* already closed */
	}
	rmSync(TEST_DB_PATH, { force: true });
	rmSync(`${TEST_DB_PATH}-wal`, { force: true });
	rmSync(`${TEST_DB_PATH}-shm`, { force: true });
	rmSync(TEST_FILES_PATH, { recursive: true, force: true });
});

function insertNoteRow(id: string, sizeBytes: number): void {
	db.insert(notes)
		.values({
			id,
			encryptedData: Buffer.alloc(0),
			serverNonce: "iv",
			clientNonce: "nonce",
			deleteToken: "token",
			expiresAt: new Date(Date.now() + 3_600_000),
			createdAt: new Date(),
			sizeBytes,
		})
		.run();
}

describe("getStorageUsedBytes", () => {
	it("returns 0 for an empty database", () => {
		expect(getStorageUsedBytes(db)).toBe(0);
	});

	it("sums note payloads and in-flight upload chunks", () => {
		insertNoteRow("note-aaaaaaaa", 100);
		insertNoteRow("note-bbbbbbbb", 250);
		db.insert(uploads)
			.values({
				id: "upload-session-1",
				metadata: "{}",
				chunkCount: 2,
				noteId: "note-cccccccc",
				deleteToken: "token",
				createdAt: new Date(),
				expiresAt: new Date(Date.now() + 3_600_000),
			})
			.run();
		db.insert(uploadChunks)
			.values([
				{ uploadId: "upload-session-1", chunkIndex: 0, sizeBytes: 40 },
				{ uploadId: "upload-session-1", chunkIndex: 1, sizeBytes: 60 },
			])
			.run();

		expect(getStorageUsedBytes(db)).toBe(450);
	});
});

describe("assertStorageQuota", () => {
	it("is disabled when the quota is 0", () => {
		insertNoteRow("note-aaaaaaaa", 10_000);
		expect(() => assertStorageQuota(db, 0, 1_000_000)).not.toThrow();
	});

	it("allows a write that lands exactly on the quota", () => {
		insertNoteRow("note-aaaaaaaa", 60);
		expect(() => assertStorageQuota(db, 100, 40)).not.toThrow();
	});

	it("throws 507 when the write would exceed the quota", () => {
		insertNoteRow("note-aaaaaaaa", 60);
		try {
			assertStorageQuota(db, 100, 41);
			expect.unreachable("assertStorageQuota should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(HTTPException);
			expect((err as HTTPException).status).toBe(507);
			expect((err as HTTPException).message).toBe("Storage quota exceeded");
		}
	});
});

describe("storage quota over HTTP", () => {
	it("refuses a note create that would exceed the quota with 507", async () => {
		const app = createQuotaApp(db, 100);

		const first = await app.request("/api/v1/notes", {
			method: "POST",
			headers: authHeaders({ "Content-Type": "application/json" }),
			body: createBody(60),
		});
		expect(first.status).toBe(201);
		expect(getStorageUsedBytes(db)).toBe(60 + TAG_BYTES);

		const second = await app.request("/api/v1/notes", {
			method: "POST",
			headers: authHeaders({ "Content-Type": "application/json" }),
			body: createBody(60),
		});
		expect(second.status).toBe(507);
		expect(await second.json()).toEqual({ error: "Storage quota exceeded" });
	});

	it("frees quota when a note is deleted", async () => {
		const app = createQuotaApp(db, 100);

		const first = await app.request("/api/v1/notes", {
			method: "POST",
			headers: authHeaders({ "Content-Type": "application/json" }),
			body: createBody(60),
		});
		const { id, deleteToken } = (await first.json()) as { id: string; deleteToken: string };

		const del = await app.request(`/api/v1/notes/${id}`, {
			method: "DELETE",
			headers: authHeaders({ "X-Delete-Token": deleteToken }),
		});
		expect(del.status).toBe(200);
		expect(getStorageUsedBytes(db)).toBe(0);

		const second = await app.request("/api/v1/notes", {
			method: "POST",
			headers: authHeaders({ "Content-Type": "application/json" }),
			body: createBody(60),
		});
		expect(second.status).toBe(201);
	});

	it("refuses a multipart upload that would exceed the quota with 507", async () => {
		const real = new LocalStorage(TEST_FILES_PATH);
		const save = vi.fn();
		const storage = overrideStorage(real, { save });
		const app = createQuotaApp(db, 50, storage);

		const form = new FormData();
		form.append(
			"metadata",
			JSON.stringify({
				clientNonce: Buffer.from("test-nonce-24-bytes!!!!").toString("base64"),
				hasPassword: false,
				expiresIn: 3600,
				maxReads: 0,
				fileCount: 1,
			}),
		);
		form.append(
			"data",
			new Blob([Buffer.alloc(60, 7)] as BlobPart[], { type: "application/octet-stream" }),
		);

		const res = await app.request("/api/v1/notes/upload", {
			method: "POST",
			headers: authHeaders(),
			body: form,
		});
		expect(res.status).toBe(507);
		expect(save).not.toHaveBeenCalled();
	});

	it("refuses to open an upload session on a full instance", async () => {
		insertNoteRow("note-aaaaaaaa", 60);
		const app = createQuotaApp(db, 50);

		const { status } = await initUpload(app);
		expect(status).toBe(507);
	});

	it("refuses a chunk that would exceed the quota, writing nothing", async () => {
		const real = new LocalStorage(TEST_FILES_PATH);
		const saveChunk = vi.fn();
		const storage = overrideStorage(real, { saveChunk });
		const app = createQuotaApp(db, 100, storage);

		const { status, uploadId } = await initUpload(app);
		expect(status).toBe(201);

		expect(await putChunk(app, uploadId, 0, 100)).toBe(507);
		expect(saveChunk).not.toHaveBeenCalled();
		expect(db.select().from(uploadChunks).all()).toEqual([]);
	});

	it("counts uploaded chunks and moves their total onto the completed note", async () => {
		const app = createQuotaApp(db, 10_000);

		const { uploadId } = await initUpload(app, 2);
		expect(await putChunk(app, uploadId, 0, 40)).toBe(200);
		expect(await putChunk(app, uploadId, 1, 50)).toBe(200);

		const inFlight = 40 + CHUNK_OVERHEAD + (50 + CHUNK_OVERHEAD);
		expect(getStorageUsedBytes(db)).toBe(inFlight);

		const complete = await app.request(`/api/v1/notes/upload/${uploadId}/complete`, {
			method: "POST",
			headers: authHeaders(),
		});
		expect(complete.status).toBe(201);
		const { id } = (await complete.json()) as { id: string };

		// The session rows cascaded away; the same bytes now live on the note.
		expect(db.select().from(uploadChunks).all()).toEqual([]);
		const note = db
			.select({ sizeBytes: notes.sizeBytes })
			.from(notes)
			.where(eq(notes.id, id))
			.get();
		expect(note?.sizeBytes).toBe(inFlight);
		expect(getStorageUsedBytes(db)).toBe(inFlight);
	});

	it("updates the recorded size when a chunk is re-uploaded", async () => {
		const app = createQuotaApp(db, 10_000);

		const { uploadId } = await initUpload(app, 2);
		expect(await putChunk(app, uploadId, 0, 40)).toBe(200);
		expect(await putChunk(app, uploadId, 0, 90, 2)).toBe(200);

		const rows = db.select().from(uploadChunks).all();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.sizeBytes).toBe(90 + CHUNK_OVERHEAD);
	});
});

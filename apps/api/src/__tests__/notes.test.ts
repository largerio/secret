import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
// Extends Zod with `.openapi()` before `@largerio/secret-shared` builds its
// schemas, as the routes expect (the production entry point does the same).
import "@hono/zod-openapi";
import {
	MAX_INLINE_ENCRYPTED_SIZE,
	NOTE_ID_LENGTH,
	UPLOAD_ID_LENGTH,
} from "@largerio/secret-shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../app.js";
import type { AppDatabase } from "../db/index.js";
import { createDatabase } from "../db/index.js";
import { notes as notesTable, pendingDeletions } from "../db/schema.js";
import type { StorageBackend } from "../storage/index.js";
import { LocalStorage } from "../storage/local.js";
import { overrideStorage, stubStorage } from "./storageDoubles.js";
import { createTestApp, createTestNotesService } from "./testApp.js";

vi.mock("../routes/cap.js", () => ({
	cap: {
		validateToken: vi.fn((token: string) =>
			Promise.resolve({ success: token === "valid-cap-token" }),
		),
	},
	createCapRoutes: () => new Hono(),
}));

const TEST_DB_PATH = "./data/test.db";
const TEST_FILES_PATH = "./data/test-files";
const TEST_SERVER_KEY = randomBytes(32);
const API_KEY = randomBytes(32).toString("base64url");
const METRICS_TOKEN = randomBytes(32).toString("base64url");

let db: AppDatabase;
let sqlite: DatabaseSync;
let app: Hono<AppEnv>;

const stops: Array<() => void> = [];

/** The real application over the given storage; `env` configures it. */
function createApp(
	database: AppDatabase,
	storage: StorageBackend = new LocalStorage(TEST_FILES_PATH),
	env: Record<string, string> = {},
): Hono<AppEnv> {
	const { app: created, stop } = createTestApp({
		db: database,
		serverKey: TEST_SERVER_KEY,
		storage,
		env,
	});
	stops.push(stop);
	return created;
}

function createAppWithFailingPurge(database: AppDatabase) {
	return createApp(
		database,
		overrideStorage(new LocalStorage(TEST_FILES_PATH), {
			purge: () => Promise.reject(new Error("Simulated storage failure")),
		}),
	);
}

function pendingNoteIds(): string[] {
	return db
		.select()
		.from(pendingDeletions)
		.all()
		.map((row) => row.noteId);
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
	return { "X-Cap-Token": "valid-cap-token", ...extra };
}

function validBody(overrides: Record<string, unknown> = {}) {
	return {
		encryptedData: Buffer.from("test-encrypted-data").toString("base64"),
		clientNonce: Buffer.from("test-nonce-24-bytes!!!!").toString("base64"),
		hasPassword: false,
		expiresIn: 3600,
		maxReads: 0,
		fileCount: 0,
		...overrides,
	};
}

async function createTestNote(body: Record<string, unknown> = {}) {
	const res = await app.request("/api/v1/notes", {
		method: "POST",
		headers: authHeaders({ "Content-Type": "application/json" }),
		body: JSON.stringify(validBody(body)),
	});
	return res.json() as Promise<{ id: string; expiresAt: string; deleteToken: string }>;
}

function multipartForm(
	metadata: Record<string, unknown>,
	data: Uint8Array = Buffer.from("test-encrypted-data"),
): FormData {
	const form = new FormData();
	form.append("metadata", JSON.stringify(metadata));
	form.append("data", new Blob([data] as BlobPart[], { type: "application/octet-stream" }));
	return form;
}

function validMultipartMeta(overrides: Record<string, unknown> = {}) {
	return {
		clientNonce: Buffer.from("test-nonce-24-bytes!!!!").toString("base64"),
		hasPassword: false,
		expiresIn: 3600,
		maxReads: 0,
		fileCount: 1,
		...overrides,
	};
}

beforeAll(() => {
	mkdirSync("./data", { recursive: true });
	mkdirSync(TEST_FILES_PATH, { recursive: true });
});

beforeEach(() => {
	try {
		rmSync(TEST_DB_PATH, { force: true });
		rmSync(`${TEST_DB_PATH}-wal`, { force: true });
		rmSync(`${TEST_DB_PATH}-shm`, { force: true });
	} catch {
		/* ignore */
	}
	const result = createDatabase(TEST_DB_PATH);
	db = result.db;
	sqlite = result.sqlite;
	app = createApp(db);
});

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(() => {
	for (const stop of stops) stop();
	try {
		rmSync(TEST_DB_PATH, { force: true });
		rmSync(`${TEST_DB_PATH}-wal`, { force: true });
		rmSync(`${TEST_DB_PATH}-shm`, { force: true });
		rmSync(TEST_FILES_PATH, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

describe("write authentication", () => {
	// Attached route by route, before the route's validators: a request without
	// authentication learns nothing of what its body should have been.
	it("refuses an unauthenticated write before it validates the request", async () => {
		const { id } = await createTestNote();

		for (const [path, init] of [
			["/api/v1/notes", { method: "POST", body: "not json" }],
			["/api/v1/notes/upload", { method: "POST", body: "not multipart" }],
			["/api/v1/notes/upload/init", { method: "POST", body: "{}" }],
			[`/api/v1/notes/${id}`, { method: "DELETE" }],
			["/api/v1/notes/not-an-id", { method: "DELETE" }],
		] as const) {
			const res = await app.request(path, init);
			expect(res.status, `${init.method} ${path}`).toBe(401);
			expect(await res.json()).toEqual({ error: "Unauthorized" });
		}
		expect(db.select().from(notesTable).all()).toHaveLength(1);
	});

	// Every route of the notes API as the app registered it, documented or not:
	// a write registered without `middleware: writeAuth` answers something else
	// than 401, and fails here.
	it("guards every write but an upload's chunks, its completion and the format 1 read", async () => {
		const prefix = "/api/v1/notes";
		const writes = new Set<string>();
		for (const route of app.routes) {
			// What `use` registers runs whatever the method: ALL.
			if (!route.path.startsWith(prefix) || route.method === "GET" || route.method === "ALL") {
				continue;
			}
			writes.add(`${route.method} ${route.path}`);
		}

		// Every write the OpenAPI document lists is walked, so the walk does not
		// miss a route by its spelling.
		const doc = (await (await app.request("/api/v1/openapi.json")).json()) as {
			paths: Record<string, Record<string, unknown>>;
		};
		const documented = Object.entries(doc.paths).flatMap(([path, operations]) =>
			Object.keys(operations)
				.filter((method) => method !== "get")
				.map((method) => `${method.toUpperCase()} /api/v1${path.replaceAll(/\{(\w+)\}/g, ":$1")}`),
		);
		expect(documented.length).toBeGreaterThan(0);
		expect([...writes]).toEqual(expect.arrayContaining(documented));

		const unguarded: string[] = [];
		for (const write of writes) {
			const [method = "", path = ""] = write.split(" ");
			const url = path
				.replace(":id", "a".repeat(NOTE_ID_LENGTH))
				.replace(":uploadId", "u".repeat(UPLOAD_ID_LENGTH))
				.replace(":index", "0");
			const res = await app.request(url, { method });
			if (res.status !== 401) {
				unguarded.push(`${method} ${path.slice(prefix.length)}`);
			}
		}
		expect(unguarded.sort()).toEqual([
			"POST /:id/reads",
			"POST /upload/:uploadId/complete",
			"PUT /upload/:uploadId/chunks/:index",
		]);
	});
});

describe("POST /api/v1/notes", () => {
	it("rejects requests without Cap token or API key", async () => {
		const res = await app.request("/api/v1/notes", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(validBody()),
		});
		expect(res.status).toBe(401);
		const json = await res.json();
		expect(json.error).toBe("Unauthorized");
	});

	it("refuses a note without files beyond the inline ceiling", async () => {
		const res = await app.request("/api/v1/notes", {
			method: "POST",
			headers: authHeaders({ "Content-Type": "application/json" }),
			body: JSON.stringify(
				validBody({
					encryptedData: Buffer.alloc(MAX_INLINE_ENCRYPTED_SIZE + 1).toString("base64"),
				}),
			),
		});
		expect(res.status).toBe(413);
		expect(await res.json()).toEqual({ error: "Payload too large" });
	});

	it("accepts a note without files at the inline ceiling", async () => {
		const res = await app.request("/api/v1/notes", {
			method: "POST",
			headers: authHeaders({ "Content-Type": "application/json" }),
			body: JSON.stringify(
				validBody({ encryptedData: Buffer.alloc(MAX_INLINE_ENCRYPTED_SIZE).toString("base64") }),
			),
		});
		expect(res.status).toBe(201);
	});

	it("leaves notes with files to the body limit, since they go to storage", async () => {
		const res = await app.request("/api/v1/notes", {
			method: "POST",
			headers: authHeaders({ "Content-Type": "application/json" }),
			body: JSON.stringify(
				validBody({
					encryptedData: Buffer.alloc(MAX_INLINE_ENCRYPTED_SIZE + 1).toString("base64"),
					fileCount: 1,
				}),
			),
		});
		expect(res.status).toBe(201);
	});

	it("rejects requests with an invalid API key", async () => {
		const res = await app.request("/api/v1/notes", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer bad-key",
			},
			body: JSON.stringify(validBody()),
		});
		expect(res.status).toBe(401);
		const json = await res.json();
		expect(json.error).toBe("Unauthorized");
	});

	it("accepts a valid API key instead of Cap token", async () => {
		const apiApp = createApp(db, undefined, { API_KEY: API_KEY });

		const res = await apiApp.request("/api/v1/notes", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${API_KEY}`,
			},
			body: JSON.stringify(validBody()),
		});
		expect(res.status).toBe(201);
		const json = await res.json();
		expect(json.id).toBeDefined();
	});

	it("creates a note and returns id, expiresAt, and deleteToken", async () => {
		const res = await app.request("/api/v1/notes", {
			method: "POST",
			headers: authHeaders({ "Content-Type": "application/json" }),
			body: JSON.stringify(validBody()),
		});
		expect(res.status).toBe(201);
		const json = await res.json();
		expect(json.id).toBeDefined();
		expect(json.id.length).toBe(12);
		expect(json.expiresAt).toBeDefined();
		expect(json.deleteToken).toBeDefined();
		expect(json.deleteToken.length).toBe(32);
	});

	it("rejects missing encryptedData", async () => {
		const res = await app.request("/api/v1/notes", {
			method: "POST",
			headers: authHeaders({ "Content-Type": "application/json" }),
			body: JSON.stringify(validBody({ encryptedData: "" })),
		});
		expect(res.status).toBe(400);
	});

	it("rejects expiresIn too low", async () => {
		const res = await app.request("/api/v1/notes", {
			method: "POST",
			headers: authHeaders({ "Content-Type": "application/json" }),
			body: JSON.stringify(validBody({ expiresIn: 10 })),
		});
		expect(res.status).toBe(400);
	});

	it("rejects expiresIn too high", async () => {
		const res = await app.request("/api/v1/notes", {
			method: "POST",
			headers: authHeaders({ "Content-Type": "application/json" }),
			body: JSON.stringify(validBody({ expiresIn: 9999999 })),
		});
		expect(res.status).toBe(400);
	});

	it("creates a note with files on disk", async () => {
		const res = await app.request("/api/v1/notes", {
			method: "POST",
			headers: authHeaders({ "Content-Type": "application/json" }),
			body: JSON.stringify(validBody({ fileCount: 2 })),
		});
		expect(res.status).toBe(201);
		const { id } = (await res.json()) as { id: string };

		// The ciphertext lives in the storage; the row only points to it.
		const row = db.select().from(notesTable).where(eq(notesTable.id, id)).get();
		expect(row?.fileCount).toBe(2);
		expect(row?.encryptedData.length).toBe(0);
		expect(row?.filePath).toBeTruthy();
		expect(existsSync(row?.filePath ?? "")).toBe(true);
	});

	it("creates a note with password and salt", async () => {
		const testSalt = Buffer.from("test-salt-data-16bytes").toString("base64");
		const res = await app.request("/api/v1/notes", {
			method: "POST",
			headers: authHeaders({ "Content-Type": "application/json" }),
			body: JSON.stringify(validBody({ hasPassword: true, salt: testSalt })),
		});
		expect(res.status).toBe(201);
	});

	it("rejects hasPassword without salt", async () => {
		const res = await app.request("/api/v1/notes", {
			method: "POST",
			headers: authHeaders({ "Content-Type": "application/json" }),
			body: JSON.stringify(validBody({ hasPassword: true })),
		});
		expect(res.status).toBe(400);
	});

	it("stores and returns salt for password-protected notes", async () => {
		const testSalt = Buffer.from("test-salt-data-16bytes").toString("base64");
		const { id } = await createTestNote({ hasPassword: true, salt: testSalt });

		const readRes = await app.request(`/api/v1/notes/${id}`);
		expect(readRes.status).toBe(200);
		const note = await readRes.json();
		expect(note.hasPassword).toBe(true);
		expect(note.salt).toBe(testSalt);
	});

	it("creates a note with maxReads", async () => {
		const res = await app.request("/api/v1/notes", {
			method: "POST",
			headers: authHeaders({ "Content-Type": "application/json" }),
			body: JSON.stringify(validBody({ maxReads: 3 })),
		});
		expect(res.status).toBe(201);
	});

	// Without `required`, a request with no Content-Type skipped validation and
	// reached the handler empty: a 500.
	it("refuses a create without a body or without a Content-Type", async () => {
		const empty = await app.request("/api/v1/notes", { method: "POST", headers: authHeaders() });
		expect(empty.status).toBe(400);

		const untyped = await app.request("/api/v1/notes", {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify(validBody()),
		});
		expect(untyped.status).toBe(415);

		const init = await app.request("/api/v1/notes/upload/init", {
			method: "POST",
			headers: authHeaders(),
		});
		expect(init.status).toBe(400);
	});

	it("rejects invalid JSON body", async () => {
		const res = await app.request("/api/v1/notes", {
			method: "POST",
			headers: authHeaders({ "Content-Type": "application/json" }),
			body: "not json",
		});
		expect(res.status).toBe(400);
	});
});

describe("POST /api/v1/notes/upload (multipart)", () => {
	it("refuses a body that is not multipart as an unsupported media type", async () => {
		const res = await app.request("/api/v1/notes/upload", {
			method: "POST",
			headers: authHeaders({ "Content-Type": "application/json" }),
			body: JSON.stringify({ invalid: true }),
		});
		expect(res.status).toBe(415);
	});

	it("creates a note via multipart upload", async () => {
		const form = multipartForm(validMultipartMeta());
		const res = await app.request("/api/v1/notes/upload", {
			method: "POST",
			headers: authHeaders(),
			body: form,
		});
		expect(res.status).toBe(201);
		const json = await res.json();
		expect(json.id).toBeDefined();
		expect(json.id.length).toBe(12);
		expect(json.deleteToken).toBeDefined();
		expect(json.deleteToken.length).toBe(32);
		expect(json.expiresAt).toBeDefined();
	});

	it("reads back a multipart-uploaded note", async () => {
		const form = multipartForm(validMultipartMeta());
		const createRes = await app.request("/api/v1/notes/upload", {
			method: "POST",
			headers: authHeaders(),
			body: form,
		});
		const { id } = (await createRes.json()) as { id: string };

		const readRes = await app.request(`/api/v1/notes/${id}`);
		expect(readRes.status).toBe(200);
		const note = await readRes.json();
		expect(note.fileCount).toBe(1);
		expect(note.encryptedData).toBeDefined();
	});

	it("rejects missing metadata part", async () => {
		const form = new FormData();
		form.append("data", new Blob([Buffer.from("test")] as BlobPart[]));
		const res = await app.request("/api/v1/notes/upload", {
			method: "POST",
			headers: authHeaders(),
			body: form,
		});
		expect(res.status).toBe(400);
	});

	it("rejects missing data part", async () => {
		const form = new FormData();
		form.append("metadata", JSON.stringify(validMultipartMeta()));
		const res = await app.request("/api/v1/notes/upload", {
			method: "POST",
			headers: authHeaders(),
			body: form,
		});
		expect(res.status).toBe(400);
	});

	it("rejects invalid metadata JSON", async () => {
		const form = new FormData();
		form.append("metadata", "not-json{{{");
		form.append("data", new Blob([Buffer.from("test")] as BlobPart[]));
		const res = await app.request("/api/v1/notes/upload", {
			method: "POST",
			headers: authHeaders(),
			body: form,
		});
		expect(res.status).toBe(400);
	});

	it("rejects invalid metadata schema", async () => {
		const form = multipartForm({ fileCount: 1 });
		const res = await app.request("/api/v1/notes/upload", {
			method: "POST",
			headers: authHeaders(),
			body: form,
		});
		expect(res.status).toBe(400);
	});

	it("supports password-protected multipart upload", async () => {
		const testSalt = Buffer.from("test-salt").toString("base64");
		const form = multipartForm(validMultipartMeta({ hasPassword: true, salt: testSalt }));
		const res = await app.request("/api/v1/notes/upload", {
			method: "POST",
			headers: authHeaders(),
			body: form,
		});
		expect(res.status).toBe(201);
	});

	it("supports maxReads via multipart upload", async () => {
		const form = multipartForm(validMultipartMeta({ maxReads: 1 }));
		const createRes = await app.request("/api/v1/notes/upload", {
			method: "POST",
			headers: authHeaders(),
			body: form,
		});
		expect(createRes.status).toBe(201);
		const { id } = (await createRes.json()) as { id: string };

		const readRes = await app.request(`/api/v1/notes/${id}`);
		expect(readRes.status).toBe(200);

		const secondRead = await app.request(`/api/v1/notes/${id}`);
		expect(secondRead.status).toBe(404);
	});
});

describe("GET /api/v1/notes/:id/exists", () => {
	it("returns exists true for a valid note", async () => {
		const { id } = await createTestNote();

		const res = await app.request(`/api/v1/notes/${id}/exists`);
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.exists).toBe(true);
		expect(json.hasPassword).toBe(false);
		expect(json.fileCount).toBe(0);
		expect(json.maxReads).toBe(0);
		expect(json.readCount).toBe(0);
		expect(json.expiresAt).toBeDefined();
	});

	it("reports readCount 0 for a fresh multi-read note", async () => {
		const { id } = await createTestNote({ maxReads: 3 });

		const res = await app.request(`/api/v1/notes/${id}/exists`);
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.maxReads).toBe(3);
		expect(json.readCount).toBe(0);
	});

	it("counts a read of a multi-read note without consuming one itself", async () => {
		const { id } = await createTestNote({ maxReads: 3 });

		const readRes = await app.request(`/api/v1/notes/${id}`);
		expect(readRes.status).toBe(200);

		const first = await (await app.request(`/api/v1/notes/${id}/exists`)).json();
		const second = await (await app.request(`/api/v1/notes/${id}/exists`)).json();
		expect(first.readCount).toBe(1);
		// Probing is free: /exists must never move the count.
		expect(second.readCount).toBe(1);
		expect(second.maxReads).toBe(3);
	});

	it("keeps readCount at 0 for an unlimited note, however often it is read", async () => {
		const { id } = await createTestNote({ maxReads: 0 });

		await app.request(`/api/v1/notes/${id}`);
		await app.request(`/api/v1/notes/${id}`);

		const json = await (await app.request(`/api/v1/notes/${id}/exists`)).json();
		expect(json.exists).toBe(true);
		expect(json.maxReads).toBe(0);
		expect(json.readCount).toBe(0);
	});

	it("keeps readCount at 0 for a legacy note whose maxReads is null", async () => {
		const { id } = await createTestNote({ maxReads: 3 });
		await app.request(`/api/v1/notes/${id}`);
		db.update(notesTable).set({ maxReads: null }).where(eq(notesTable.id, id)).run();

		const json = await (await app.request(`/api/v1/notes/${id}/exists`)).json();
		expect(json.maxReads).toBe(0);
		expect(json.readCount).toBe(0);
	});

	it("returns maxReads 0 when database value is null", async () => {
		const { id } = await createTestNote();
		db.update(notesTable).set({ maxReads: null }).where(eq(notesTable.id, id)).run();

		const res = await app.request(`/api/v1/notes/${id}/exists`);
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.maxReads).toBe(0);
	});

	it("reads note with null maxReads without error", async () => {
		const { id } = await createTestNote();
		db.update(notesTable).set({ maxReads: null }).where(eq(notesTable.id, id)).run();

		const res = await app.request(`/api/v1/notes/${id}`);
		expect(res.status).toBe(200);
	});

	it("returns exists false for a non-existent note", async () => {
		const res = await app.request("/api/v1/notes/nonexistent1/exists");
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.exists).toBe(false);
	});

	it("returns exists false for an expired note", async () => {
		const { id } = await createTestNote({ expiresIn: 300 });

		// Manually expire the note by updating the DB
		db.update(notesTable)
			.set({ expiresAt: new Date(Date.now() - 1000) })
			.where(eq(notesTable.id, id))
			.run();

		const res = await app.request(`/api/v1/notes/${id}/exists`);
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.exists).toBe(false);
	});

	it("reveals nothing about an expired note that had been read", async () => {
		const { id } = await createTestNote({ maxReads: 3 });
		await app.request(`/api/v1/notes/${id}`);
		const before = await (await app.request(`/api/v1/notes/${id}/exists`)).json();
		expect(before.readCount).toBe(1);

		db.update(notesTable)
			.set({ expiresAt: new Date(Date.now() - 1000) })
			.where(eq(notesTable.id, id))
			.run();

		const res = await app.request(`/api/v1/notes/${id}/exists`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ exists: false });
	});

	it("reveals nothing once the last read burns the note", async () => {
		const { id } = await createTestNote({ maxReads: 2 });
		await app.request(`/api/v1/notes/${id}`);
		const before = await (await app.request(`/api/v1/notes/${id}/exists`)).json();
		expect(before.readCount).toBe(1);
		await app.request(`/api/v1/notes/${id}`);

		const res = await app.request(`/api/v1/notes/${id}/exists`);
		expect(await res.json()).toEqual({ exists: false });
	});

	it("returns 400 for invalid note ID format", async () => {
		const res = await app.request("/api/v1/notes/bad!id@#$/exists");
		expect(res.status).toBe(400);
	});

	it("returns 400 for too-short note ID on exists", async () => {
		const res = await app.request("/api/v1/notes/short/exists");
		expect(res.status).toBe(400);
		const json = await res.json();
		expect(json.error).toBe("Invalid request");
	});

	it("returns correct metadata for password-protected note with files", async () => {
		const testSalt = Buffer.from("test-salt-16bytes").toString("base64");
		const { id } = await createTestNote({
			hasPassword: true,
			salt: testSalt,
			fileCount: 3,
			maxReads: 1,
		});

		const res = await app.request(`/api/v1/notes/${id}/exists`);
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.hasPassword).toBe(true);
		expect(json.fileCount).toBe(3);
		expect(json.maxReads).toBe(1);
	});
});

describe("GET /api/v1/notes/:id", () => {
	it("returns the encrypted note data with all fields", async () => {
		const { id } = await createTestNote();

		const res = await app.request(`/api/v1/notes/${id}`);
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.encryptedData).toBeDefined();
		expect(json.clientNonce).toBeDefined();
		expect(json.hasPassword).toBe(false);
		expect(json.fileCount).toBe(0);
		expect(json.createdAt).toBeDefined();
		expect(json.expiresAt).toBeDefined();
		expect(new Date(json.createdAt).getTime()).not.toBeNaN();
		expect(new Date(json.expiresAt).getTime()).not.toBeNaN();
	});

	it("returns 404 for a non-existent note", async () => {
		const res = await app.request("/api/v1/notes/nonexistent1");
		expect(res.status).toBe(404);
	});

	it("returns 400 for invalid note ID format", async () => {
		const res = await app.request("/api/v1/notes/bad!id@");
		expect(res.status).toBe(400);
	});

	it("deletes note after read when maxReads is 1", async () => {
		const { id } = await createTestNote({ maxReads: 1 });

		const readRes = await app.request(`/api/v1/notes/${id}`);
		expect(readRes.status).toBe(200);

		const secondRead = await app.request(`/api/v1/notes/${id}`);
		expect(secondRead.status).toBe(404);
	});

	it("deletes file from disk when maxReads is reached with files", async () => {
		const { id } = await createTestNote({ maxReads: 1, fileCount: 1 });

		const filePath = `${TEST_FILES_PATH}/${id}`;
		expect(existsSync(filePath)).toBe(true);

		const readRes = await app.request(`/api/v1/notes/${id}`);
		expect(readRes.status).toBe(200);

		// Purged once the answer is out, not before it.
		await vi.waitFor(() => expect(existsSync(filePath)).toBe(false));
		expect(pendingNoteIds()).toEqual([]);
	});

	it("increments readCount for non-burn notes", async () => {
		const { id } = await createTestNote();

		await app.request(`/api/v1/notes/${id}`);
		await app.request(`/api/v1/notes/${id}`);

		const res = await app.request(`/api/v1/notes/${id}`);
		expect(res.status).toBe(200);
	});

	it("returns 404 when maxReads is exceeded", async () => {
		const { id } = await createTestNote({ maxReads: 1 });

		const firstRead = await app.request(`/api/v1/notes/${id}`);
		expect(firstRead.status).toBe(200);

		const secondRead = await app.request(`/api/v1/notes/${id}`);
		expect(secondRead.status).toBe(404);
	});

	it("answers a burned file note without waiting for its purge", async () => {
		const { id } = await createTestNote({ maxReads: 1, fileCount: 1 });
		let release: (() => void) | undefined;
		const purge = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		const slowStorage = overrideStorage(new LocalStorage(TEST_FILES_PATH), { purge });

		// A purge that never ends used to hold the answer with it.
		const res = await createApp(db, slowStorage).request(`/api/v1/notes/${id}`);

		expect(res.status).toBe(200);
		expect(purge).toHaveBeenCalledExactlyOnceWith(id);
		release?.();
	});

	it("deletes file when maxReads is exceeded on file note", async () => {
		const { id } = await createTestNote({ maxReads: 1, fileCount: 1 });

		const filePath = `${TEST_FILES_PATH}/${id}`;
		expect(existsSync(filePath)).toBe(true);

		await app.request(`/api/v1/notes/${id}`);
		const secondRead = await app.request(`/api/v1/notes/${id}`);
		expect(secondRead.status).toBe(404);
		await vi.waitFor(() => expect(existsSync(filePath)).toBe(false));
	});

	it("reads note with file data from disk", async () => {
		const { id } = await createTestNote({ fileCount: 1 });

		const res = await app.request(`/api/v1/notes/${id}`);
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.fileCount).toBe(1);
	});

	it("returns 404 for expired note and cleans up", async () => {
		const { id } = await createTestNote({ expiresIn: 300 });

		db.update(notesTable)
			.set({ expiresAt: new Date(Date.now() - 1000) })
			.where(eq(notesTable.id, id))
			.run();

		const res = await app.request(`/api/v1/notes/${id}`);
		expect(res.status).toBe(404);
		const json = await res.json();
		expect(json.error).toBe("Note not found");
	});

	it("returns 404 and deletes file for expired note with files", async () => {
		const { id } = await createTestNote({ expiresIn: 300, fileCount: 1 });

		const filePath = `${TEST_FILES_PATH}/${id}`;
		expect(existsSync(filePath)).toBe(true);

		db.update(notesTable)
			.set({ expiresAt: new Date(Date.now() - 1000) })
			.where(eq(notesTable.id, id))
			.run();

		const res = await app.request(`/api/v1/notes/${id}`);
		expect(res.status).toBe(404);
		await vi.waitFor(() => expect(existsSync(filePath)).toBe(false));
		expect(pendingNoteIds()).toEqual([]);
	});

	it("counts an expired note a read deletes with the ones the cleanup job deletes", async () => {
		const { id } = await createTestNote({ expiresIn: 300 });
		db.update(notesTable)
			.set({ expiresAt: new Date(Date.now() - 1000) })
			.where(eq(notesTable.id, id))
			.run();

		const metered = createApp(db, undefined, { METRICS_TOKEN });
		const res = await metered.request(`/api/v1/notes/${id}`);
		expect(res.status).toBe(404);

		const scrape = await metered.request("/api/metrics", {
			headers: { Authorization: `Bearer ${METRICS_TOKEN}` },
		});
		expect(await scrape.text()).toMatch(/^secret_notes_expired_total 1$/m);
	});

	it("does not return salt for non-password notes", async () => {
		const { id } = await createTestNote();

		const res = await app.request(`/api/v1/notes/${id}`);
		const json = await res.json();
		expect(json.salt).toBeUndefined();
	});

	it("returns 500 when server decryption fails due to corrupted data", async () => {
		const { id } = await createTestNote();

		// Corrupt the encrypted data directly in the database
		db.update(notesTable)
			.set({ encryptedData: Buffer.from("corrupted-data") })
			.where(eq(notesTable.id, id))
			.run();

		const res = await app.request(`/api/v1/notes/${id}`);
		expect(res.status).toBe(500);
		const json = await res.json();
		expect(json.error).toBe("Failed to decrypt note");
	});

	it("rejects a stored blob relocated from another note (AAD binding to id)", async () => {
		// Each note's server-layer blob is bound to its id via AAD. Moving one
		// note's full crypto material (blob + IV) into another row would decrypt
		// fine under the shared server key without AAD, but must fail here because
		// the row's id no longer matches the id the blob was encrypted under.
		const { id: idA } = await createTestNote();
		const { id: idB } = await createTestNote();

		const noteB = db.select().from(notesTable).where(eq(notesTable.id, idB)).get();
		db.update(notesTable)
			.set({ encryptedData: noteB?.encryptedData, serverNonce: noteB?.serverNonce })
			.where(eq(notesTable.id, idA))
			.run();

		const res = await app.request(`/api/v1/notes/${idA}`);
		expect(res.status).toBe(500);
		expect((await res.json()).error).toBe("Failed to decrypt note");
	});

	it("returns 404 when the stored file has been removed from disk", async () => {
		const { id } = await createTestNote({ fileCount: 1 });
		const note = db.select().from(notesTable).where(eq(notesTable.id, id)).get();
		const filePath = note?.filePath ?? "";
		expect(filePath).toBeTruthy();

		const { unlink } = await import("node:fs/promises");
		await unlink(filePath);

		const res = await app.request(`/api/v1/notes/${id}`);
		expect(res.status).toBe(404);
		expect((await res.json()).error).toBe("Note not found");

		const row = db.select().from(notesTable).where(eq(notesTable.id, id)).get();
		expect(row?.readCount).toBe(0);
	});

	it("keeps a burn-after-read note through a storage failure, then serves it once", async () => {
		const { id } = await createTestNote({ maxReads: 1, fileCount: 1 });

		const realStorage = new LocalStorage(TEST_FILES_PATH);
		let storageDown = true;
		const flakyStorage = overrideStorage(realStorage, {
			read: (key) =>
				storageDown ? Promise.reject(new Error("storage unavailable")) : realStorage.read(key),
		});
		const flakyApp = createApp(db, flakyStorage);

		// The outage is an error of the server's, logged with an id; it used to be
		// reported as a note that failed to decrypt, and not logged.
		const failed = await flakyApp.request(`/api/v1/notes/${id}`);
		expect(failed.status).toBe(500);
		expect(await failed.json()).toEqual({
			error: "Internal server error",
			errorId: expect.any(String),
		});

		storageDown = false;
		const served = await flakyApp.request(`/api/v1/notes/${id}`);
		expect(served.status).toBe(200);
		expect((await served.json()).encryptedData).toBeDefined();

		const again = await flakyApp.request(`/api/v1/notes/${id}`);
		expect(again.status).toBe(404);
	});

	it("keeps a burn-after-read file note whose blob fails to decrypt", async () => {
		const { id } = await createTestNote({ maxReads: 1, fileCount: 1 });

		// Corrupt the file on disk by writing garbage to the stored path
		const note = db.select().from(notesTable).where(eq(notesTable.id, id)).get();
		expect(note).toBeDefined();
		const filePath = note?.filePath ?? "";
		expect(filePath).toBeTruthy();

		// Overwrite the stored file with corrupted data
		const { writeFile } = await import("node:fs/promises");
		await writeFile(filePath, "corrupted-garbage");

		const res = await app.request(`/api/v1/notes/${id}`);
		expect(res.status).toBe(500);
		expect((await res.json()).error).toBe("Failed to decrypt note");

		// The read never counted: the row and its file are both still there.
		const afterNote = db.select().from(notesTable).where(eq(notesTable.id, id)).get();
		expect(afterNote?.readCount).toBe(0);
		expect(existsSync(filePath)).toBe(true);
	});

	it("queues the purge of an expired note for a retry when it fails", async () => {
		const { id } = await createTestNote({ expiresIn: 300, fileCount: 1 });
		db.update(notesTable)
			.set({ expiresAt: new Date(Date.now() - 1000) })
			.where(eq(notesTable.id, id))
			.run();
		const failApp = createAppWithFailingPurge(db);

		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const res = await failApp.request(`/api/v1/notes/${id}`);
		expect(res.status).toBe(404);

		// The row is gone but its payload is not: the purge stays queued for the
		// cleanup job, and the log does not carry the note id.
		expect(pendingNoteIds()).toEqual([id]);
		const logged = String(consoleSpy.mock.calls[0]?.[0]);
		expect(logged).toContain('"msg":"storage purge failed, retry scheduled"');
		expect(logged).not.toContain(id);
	});

	// A chunked note stores an empty `encryptedData` blob, so serving it from an
	// inline endpoint used to increment the read counter, fail to decrypt, and
	// then delete the row AND its chunks in the cleanup path — destroying the
	// note and answering 500. The shape check must run before the read is burned.
	it("rejects a chunked note on the JSON endpoint without consuming a read", async () => {
		const { id } = await createTestNote({ maxReads: 1, fileCount: 0 });
		db.update(notesTable)
			.set({ chunkCount: 1, streamHeader: "hdr" })
			.where(eq(notesTable.id, id))
			.run();

		const res = await app.request(`/api/v1/notes/${id}`);
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe("Note is chunked: read it as a stream");

		const row = db.select().from(notesTable).where(eq(notesTable.id, id)).get();
		expect(row).toBeDefined();
		expect(row?.readCount).toBe(0);
	});

	it("rejects a chunked note on the raw endpoint without consuming a read", async () => {
		const { id } = await createTestNote({ maxReads: 1, fileCount: 0 });
		db.update(notesTable)
			.set({ chunkCount: 1, streamHeader: "hdr" })
			.where(eq(notesTable.id, id))
			.run();

		const res = await app.request(`/api/v1/notes/${id}/raw`);
		expect(res.status).toBe(400);

		const row = db.select().from(notesTable).where(eq(notesTable.id, id)).get();
		expect(row?.readCount).toBe(0);
	});
});

describe("GET /api/v1/notes/:id/raw", () => {
	it("returns binary data with correct headers", async () => {
		const { id } = await createTestNote();

		const res = await app.request(`/api/v1/notes/${id}/raw`);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
		expect(res.headers.get("X-Client-Nonce")).toBeDefined();
		expect(res.headers.get("X-Has-Password")).toBe("false");
		expect(res.headers.get("X-File-Count")).toBe("0");
		expect(res.headers.get("X-Created-At")).toBeDefined();
		expect(res.headers.get("X-Expires-At")).toBeDefined();
		expect(res.headers.get("Content-Length")).toBeDefined();

		const data = await res.arrayBuffer();
		expect(data.byteLength).toBeGreaterThan(0);
	});

	it("forces download and forbids MIME sniffing on raw", async () => {
		const { id } = await createTestNote();

		const res = await app.request(`/api/v1/notes/${id}/raw`);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Disposition")).toBe("attachment");
		expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
	});

	it("returns salt header for password-protected notes", async () => {
		const testSalt = Buffer.from("test-salt-data-16bytes").toString("base64");
		const { id } = await createTestNote({ hasPassword: true, salt: testSalt });

		const res = await app.request(`/api/v1/notes/${id}/raw`);
		expect(res.status).toBe(200);
		expect(res.headers.get("X-Has-Password")).toBe("true");
		expect(res.headers.get("X-Salt")).toBe(testSalt);
	});

	it("returns 404 for non-existent note", async () => {
		const res = await app.request("/api/v1/notes/nonexistent1/raw");
		expect(res.status).toBe(404);
	});

	it("returns 400 for invalid note ID", async () => {
		const res = await app.request("/api/v1/notes/bad!id/raw");
		expect(res.status).toBe(400);
	});

	it("deletes note after read when maxReads is 1", async () => {
		const { id } = await createTestNote({ maxReads: 1 });

		const readRes = await app.request(`/api/v1/notes/${id}/raw`);
		expect(readRes.status).toBe(200);

		const secondRead = await app.request(`/api/v1/notes/${id}/raw`);
		expect(secondRead.status).toBe(404);
	});

	it("returns binary data matching JSON endpoint content", async () => {
		const { id: id1 } = await createTestNote();
		const { id: id2 } = await createTestNote();

		// Use different notes since reading consumes readCount
		const jsonRes = await app.request(`/api/v1/notes/${id1}`);
		const jsonData = await jsonRes.json();

		const rawRes = await app.request(`/api/v1/notes/${id2}/raw`);
		const rawData = await rawRes.arrayBuffer();

		// Both should return valid data
		expect(jsonData.encryptedData).toBeDefined();
		expect(rawData.byteLength).toBeGreaterThan(0);
	});
});

describe("DELETE /api/v1/notes/:id", () => {
	it("deletes an existing note with valid token", async () => {
		const { id, deleteToken } = await createTestNote();

		const deleteRes = await app.request(`/api/v1/notes/${id}`, {
			method: "DELETE",
			headers: authHeaders({ "X-Delete-Token": deleteToken }),
		});
		expect(deleteRes.status).toBe(200);
		const json = await deleteRes.json();
		expect(json.deleted).toBe(true);

		const getRes = await app.request(`/api/v1/notes/${id}`);
		expect(getRes.status).toBe(404);
	});

	it("returns 401 without auth", async () => {
		const { id } = await createTestNote();

		const res = await app.request(`/api/v1/notes/${id}`, { method: "DELETE" });
		expect(res.status).toBe(401);
	});

	it("returns 400 with auth but without delete token", async () => {
		const { id } = await createTestNote();

		const res = await app.request(`/api/v1/notes/${id}`, {
			method: "DELETE",
			headers: authHeaders(),
		});
		expect(res.status).toBe(400);
	});

	it("returns 403 with wrong delete token", async () => {
		const { id } = await createTestNote();

		const res = await app.request(`/api/v1/notes/${id}`, {
			method: "DELETE",
			headers: authHeaders({ "X-Delete-Token": "wrong-token" }),
		});
		expect(res.status).toBe(403);
	});

	it("returns 404 for a non-existent note", async () => {
		const res = await app.request("/api/v1/notes/nonexistent1", {
			method: "DELETE",
			headers: authHeaders({ "X-Delete-Token": "some-token" }),
		});
		expect(res.status).toBe(404);
	});

	it("returns 400 for invalid note ID format", async () => {
		const res = await app.request("/api/v1/notes/bad!id@#$", {
			method: "DELETE",
			headers: authHeaders({ "X-Delete-Token": "some-token" }),
		});
		expect(res.status).toBe(400);
	});

	it("deletes file from disk when note has files", async () => {
		const { id, deleteToken } = await createTestNote({ fileCount: 1 });

		const filePath = `${TEST_FILES_PATH}/${id}`;
		expect(existsSync(filePath)).toBe(true);

		const deleteRes = await app.request(`/api/v1/notes/${id}`, {
			method: "DELETE",
			headers: authHeaders({ "X-Delete-Token": deleteToken }),
		});
		expect(deleteRes.status).toBe(200);
		expect(existsSync(filePath)).toBe(false);
	});

	it("returns 403 with token of different length", async () => {
		const { id } = await createTestNote();

		const res = await app.request(`/api/v1/notes/${id}`, {
			method: "DELETE",
			headers: authHeaders({ "X-Delete-Token": "short" }),
		});
		expect(res.status).toBe(403);
	});
});

describe("storage purge resilience", () => {
	/** Creates a note through the notes service alone, over the given storage. */
	function createNote(storage: StorageBackend, fileCount: number) {
		const notes = createTestNotesService({ db, serverKey: TEST_SERVER_KEY, storage });
		return notes.create(Buffer.from("ciphertext"), {
			hasPassword: false,
			expiresIn: 3600,
			maxReads: 1,
			fileCount,
			opening: { format: 0, clientNonce: "nonce" },
		});
	}

	it("purges the stored blob when the insert fails", async () => {
		const storage = new LocalStorage(TEST_FILES_PATH);
		const saved: string[] = [];
		const trackingStorage = overrideStorage(storage, {
			save: async (id, data) => {
				saved.push(id);
				return storage.save(id, data);
			},
		});
		sqlite.exec(`CREATE TRIGGER disk_full BEFORE INSERT ON notes
			BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END`);
		// Drizzle wraps the SQLite error; the trigger's message is its cause.
		const diskFull = expect.objectContaining({
			cause: expect.objectContaining({ message: "database or disk is full" }),
		});

		await expect(createNote(trackingStorage, 1)).rejects.toThrow(diskFull);

		expect(saved).toHaveLength(1);
		expect(existsSync(`${TEST_FILES_PATH}/${saved[0]}`)).toBe(false);
		expect(pendingNoteIds()).toEqual([]);

		// A text-only note stores no blob: nothing to write, nothing to queue.
		await expect(createNote(trackingStorage, 0)).rejects.toThrow(diskFull);
		expect(saved).toHaveLength(1);
		expect(pendingNoteIds()).toEqual([]);
	});

	it("purges what a failed save left behind", async () => {
		const storage = new LocalStorage(TEST_FILES_PATH);
		const saved: string[] = [];
		const halfWriting = overrideStorage(storage, {
			save: async (id, data) => {
				saved.push(id);
				await storage.save(id, data.subarray(0, 3));
				throw new Error("no space left on device");
			},
		});

		await expect(createNote(halfWriting, 1)).rejects.toThrow("no space left on device");

		expect(existsSync(`${TEST_FILES_PATH}/${saved[0]}`)).toBe(false);
		expect(pendingNoteIds()).toEqual([]);
	});

	it("queues the purge before writing, so a crash mid-save leaves no orphan", async () => {
		let saving: string | undefined;
		// A save that never settles stands for a process killed during the write.
		const hangingStorage = stubStorage({
			save: vi.fn((id: string) => {
				saving = id;
				return new Promise<string>(() => {});
			}),
		});

		void createNote(hangingStorage, 1);
		await vi.waitFor(() => expect(saving).toBeDefined());

		const [pending] = db.select().from(pendingDeletions).all();
		expect(pending?.noteId).toBe(saving);
		// Held off long enough for a slow save to finish first.
		expect(pending?.nextRetryAt.getTime()).toBeGreaterThan(Date.now() + 59 * 60_000);
		expect(pending?.nextRetryAt.getTime()).toBeLessThanOrEqual(Date.now() + 60 * 60_000 + 1000);
	});

	it("drops the queued purge once the note row exists", async () => {
		await createTestNote({ fileCount: 1 });
		expect(pendingNoteIds()).toEqual([]);
	});

	it("delete endpoint succeeds and queues a retry when the purge fails", async () => {
		const { id, deleteToken } = await createTestNote({ fileCount: 1 });
		const failApp = createAppWithFailingPurge(db);
		vi.spyOn(console, "error").mockImplementation(() => {});

		const res = await failApp.request(`/api/v1/notes/${id}`, {
			method: "DELETE",
			headers: authHeaders({ "X-Delete-Token": deleteToken }),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).deleted).toBe(true);
		expect(pendingNoteIds()).toEqual([id]);

		const getRes = await failApp.request(`/api/v1/notes/${id}`);
		expect(getRes.status).toBe(404);
	});

	it("queues no purge when deleting a text-only note", async () => {
		const { id, deleteToken } = await createTestNote();
		const tracked = stubStorage();

		const res = await createApp(db, tracked).request(`/api/v1/notes/${id}`, {
			method: "DELETE",
			headers: authHeaders({ "X-Delete-Token": deleteToken }),
		});

		expect(res.status).toBe(200);
		expect(tracked.purge).not.toHaveBeenCalled();
		expect(pendingNoteIds()).toEqual([]);
	});

	it("burn-after-read returns data and queues a retry when the purge fails", async () => {
		const { id } = await createTestNote({ maxReads: 1, fileCount: 1 });
		const failApp = createAppWithFailingPurge(db);
		vi.spyOn(console, "error").mockImplementation(() => {});

		const res = await failApp.request(`/api/v1/notes/${id}`);
		expect(res.status).toBe(200);
		expect((await res.json()).encryptedData).toBeDefined();
		expect(pendingNoteIds()).toEqual([id]);

		const secondRead = await failApp.request(`/api/v1/notes/${id}`);
		expect(secondRead.status).toBe(404);
	});

	it("queues no purge when burning a text-only note", async () => {
		const { id } = await createTestNote({ maxReads: 1 });
		const tracked = stubStorage();

		const res = await createApp(db, tracked).request(`/api/v1/notes/${id}`);

		expect(res.status).toBe(200);
		expect(tracked.purge).not.toHaveBeenCalled();
		expect(pendingNoteIds()).toEqual([]);
	});

	describe("the purge is queued in the transaction that lets go of the payload", () => {
		function failOutboxInserts(): void {
			sqlite.exec(`CREATE TRIGGER outbox_full BEFORE INSERT ON pending_deletions
				BEGIN SELECT RAISE(ABORT, 'outbox full'); END`);
		}

		it("keeps a note whose purge cannot be queued when it is deleted", async () => {
			const { id, deleteToken } = await createTestNote({ fileCount: 1 });
			failOutboxInserts();
			vi.spyOn(console, "error").mockImplementation(() => {});

			const res = await app.request(`/api/v1/notes/${id}`, {
				method: "DELETE",
				headers: authHeaders({ "X-Delete-Token": deleteToken }),
			});

			expect(res.status).toBe(500);
			expect((await app.request(`/api/v1/notes/${id}`)).status).toBe(200);
		});

		it("does not burn a note whose purge cannot be queued", async () => {
			const { id } = await createTestNote({ maxReads: 1, fileCount: 1 });
			failOutboxInserts();
			vi.spyOn(console, "error").mockImplementation(() => {});

			expect((await app.request(`/api/v1/notes/${id}`)).status).toBe(500);

			expect(db.select().from(notesTable).where(eq(notesTable.id, id)).get()?.readCount).toBe(0);
		});

		it("drops the save's queued purge in the insert's own transaction", async () => {
			const storage = new LocalStorage(TEST_FILES_PATH);
			const saved: string[] = [];
			const trackingStorage = overrideStorage(storage, {
				save: async (id, data) => {
					saved.push(id);
					return storage.save(id, data);
				},
			});
			sqlite.exec(`CREATE TRIGGER outbox_locked BEFORE DELETE ON pending_deletions
				BEGIN SELECT RAISE(ABORT, 'outbox locked'); END`);
			vi.spyOn(console, "error").mockImplementation(() => {});

			await expect(createNote(trackingStorage, 1)).rejects.toThrow();

			// No note may exist while its blob is queued for a purge.
			expect(db.select().from(notesTable).all()).toHaveLength(0);
			expect(existsSync(`${TEST_FILES_PATH}/${saved[0]}`)).toBe(false);
		});
	});
});

describe("Chunked upload flow", () => {
	function initPayload(overrides: Record<string, unknown> = {}) {
		return {
			streamHeader: Buffer.from("test-header-24-bytes!!!").toString("base64"),
			clientNonce: Buffer.from("test-nonce-24-bytes!!!!").toString("base64"),
			hasPassword: false,
			expiresIn: 3600,
			maxReads: 0,
			fileCount: 1,
			chunkCount: 2,
			...overrides,
		};
	}

	async function initUpload(overrides: Record<string, unknown> = {}) {
		const res = await app.request("/api/v1/notes/upload/init", {
			method: "POST",
			headers: authHeaders({ "Content-Type": "application/json" }),
			body: JSON.stringify(initPayload(overrides)),
		});
		return { res, json: (await res.json()) as { uploadId: string; expiresAt: string } };
	}

	function chunkData(content: string): Uint8Array {
		return new Uint8Array(Buffer.from(content));
	}

	function sha256hex(data: Uint8Array): string {
		return createHash("sha256").update(data).digest("hex");
	}

	it("completes a full chunked upload flow", async () => {
		const { res: initRes, json: initJson } = await initUpload();
		expect(initRes.status).toBe(201);
		expect(initJson.uploadId).toBeDefined();
		expect(initJson.expiresAt).toBeDefined();

		const chunk0 = chunkData("chunk-zero-data");
		const chunk1 = chunkData("chunk-one-data!");

		// Upload chunk 0
		const res0 = await app.request(`/api/v1/notes/upload/${initJson.uploadId}/chunks/0`, {
			method: "PUT",
			headers: { "Content-Type": "application/octet-stream", "X-Chunk-Hash": sha256hex(chunk0) },
			body: chunk0 as BodyInit,
		});
		expect(res0.status).toBe(200);
		expect((await res0.json()).received).toBe(true);

		// Upload chunk 1
		const res1 = await app.request(`/api/v1/notes/upload/${initJson.uploadId}/chunks/1`, {
			method: "PUT",
			headers: { "Content-Type": "application/octet-stream", "X-Chunk-Hash": sha256hex(chunk1) },
			body: chunk1 as BodyInit,
		});
		expect(res1.status).toBe(200);

		// Complete
		const completeRes = await app.request(`/api/v1/notes/upload/${initJson.uploadId}/complete`, {
			method: "POST",
			headers: authHeaders(),
		});
		expect(completeRes.status).toBe(201);
		const note = (await completeRes.json()) as {
			id: string;
			expiresAt: string;
			deleteToken: string;
		};
		expect(note.id).toBeDefined();
		expect(note.deleteToken).toBeDefined();
	});

	it("rejects init without auth", async () => {
		const res = await app.request("/api/v1/notes/upload/init", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(initPayload()),
		});
		expect(res.status).toBe(401);
	});

	it("takes the chunks and the completion without auth: the upload id stands for it", async () => {
		const { json: initJson } = await initUpload({ chunkCount: 1 });
		const chunk = chunkData("unauthenticated chunk");

		const put = await app.request(`/api/v1/notes/upload/${initJson.uploadId}/chunks/0`, {
			method: "PUT",
			headers: { "Content-Type": "application/octet-stream", "X-Chunk-Hash": sha256hex(chunk) },
			body: chunk as BodyInit,
		});
		const complete = await app.request(`/api/v1/notes/upload/${initJson.uploadId}/complete`, {
			method: "POST",
		});

		expect(put.status).toBe(200);
		expect(complete.status).toBe(201);
	});

	it("rejects chunk with missing hash", async () => {
		const { json: initJson } = await initUpload();
		const chunk = chunkData("test");

		const res = await app.request(`/api/v1/notes/upload/${initJson.uploadId}/chunks/0`, {
			method: "PUT",
			headers: { "Content-Type": "application/octet-stream" },
			body: chunk as BodyInit,
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe("Invalid request");
	});

	it("rejects chunk with hash mismatch", async () => {
		const { json: initJson } = await initUpload();
		const chunk = chunkData("test");

		const res = await app.request(`/api/v1/notes/upload/${initJson.uploadId}/chunks/0`, {
			method: "PUT",
			headers: {
				"Content-Type": "application/octet-stream",
				"X-Chunk-Hash": sha256hex(chunkData("other")),
			},
			body: chunk as BodyInit,
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe("Chunk hash mismatch");
	});

	it.each([
		["not hex", "badhash"],
		["upper case", "A".repeat(64)],
	])("rejects a chunk hash that is %s", async (_, hash) => {
		const { json: initJson } = await initUpload();

		const res = await app.request(`/api/v1/notes/upload/${initJson.uploadId}/chunks/0`, {
			method: "PUT",
			headers: { "Content-Type": "application/octet-stream", "X-Chunk-Hash": hash },
			body: chunkData("test") as BodyInit,
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe("Invalid request");
	});

	it("handles chunk upload when session is deleted mid-upload", async () => {
		const { json: initJson } = await initUpload({ chunkCount: 2 });
		const chunk = chunkData("test");

		// Delete the upload session from DB before uploading a chunk
		const { uploads: up } = await import("../db/schema.js");
		const { eq: e } = await import("drizzle-orm");
		db.delete(up).where(e(up.id, initJson.uploadId)).run();

		const res = await app.request(`/api/v1/notes/upload/${initJson.uploadId}/chunks/0`, {
			method: "PUT",
			headers: { "Content-Type": "application/octet-stream", "X-Chunk-Hash": sha256hex(chunk) },
			body: chunk as BodyInit,
		});
		expect(res.status).toBe(404);
	});

	it("purges a chunk whose session was swept while it was being written", async () => {
		const { json: initJson } = await initUpload({ chunkCount: 2 });
		const chunk = chunkData("late");
		const { uploads: up } = await import("../db/schema.js");
		const { eq: e } = await import("drizzle-orm");
		const storage = new LocalStorage(TEST_FILES_PATH);
		let noteId = "";
		// The cleanup job deletes the expired session mid-write.
		const racingApp = createApp(
			db,
			overrideStorage(storage, {
				saveChunk: (id, index, data) => {
					noteId = id;
					db.delete(up).where(e(up.id, initJson.uploadId)).run();
					return storage.saveChunk(id, index, data);
				},
			}),
		);

		const res = await racingApp.request(`/api/v1/notes/upload/${initJson.uploadId}/chunks/0`, {
			method: "PUT",
			headers: { "Content-Type": "application/octet-stream", "X-Chunk-Hash": sha256hex(chunk) },
			body: chunk as BodyInit,
		});

		expect(res.status).toBe(404);
		expect((await res.json()).error).toBe("Upload session not found or expired");
		expect(existsSync(`${TEST_FILES_PATH}/${noteId}`)).toBe(false);
		expect(db.select().from(pendingDeletions).all()).toHaveLength(0);
	});

	it("answers 409 to a chunk that lands after its upload was completed", async () => {
		const { json: initJson } = await initUpload({ chunkCount: 1 });
		const chunk = chunkData("only");
		const put = (target: Hono<AppEnv>) =>
			target.request(`/api/v1/notes/upload/${initJson.uploadId}/chunks/0`, {
				method: "PUT",
				headers: { "Content-Type": "application/octet-stream", "X-Chunk-Hash": sha256hex(chunk) },
				body: chunk as BodyInit,
			});
		expect((await put(app)).status).toBe(200);
		const storage = new LocalStorage(TEST_FILES_PATH);
		let noteId = "";
		// A retried chunk races the client's own /complete.
		const racingApp = createApp(
			db,
			overrideStorage(storage, {
				saveChunk: async (id, index, data) => {
					noteId = id;
					const done = await app.request(`/api/v1/notes/upload/${initJson.uploadId}/complete`, {
						method: "POST",
						headers: authHeaders(),
					});
					expect(done.status).toBe(201);
					return storage.saveChunk(id, index, data);
				},
			}),
		);

		const res = await put(racingApp);

		expect(res.status).toBe(409);
		expect((await res.json()).error).toBe("Upload already completed");
		expect(pendingNoteIds()).toEqual([]);
		// The completed note keeps its chunks.
		const stream = await app.request(`/api/v1/notes/${noteId}/stream`);
		expect(stream.status).toBe(200);
		await stream.arrayBuffer();
	});

	it("queues the purge of a late chunk for a retry when it fails", async () => {
		const { json: initJson } = await initUpload({ chunkCount: 2 });
		const chunk = chunkData("late");
		const { uploads: up } = await import("../db/schema.js");
		const { eq: e } = await import("drizzle-orm");
		const storage = new LocalStorage(TEST_FILES_PATH);
		let noteId = "";
		vi.spyOn(console, "error").mockImplementation(() => {});
		const racingApp = createApp(
			db,
			overrideStorage(storage, {
				saveChunk: (id, index, data) => {
					noteId = id;
					db.delete(up).where(e(up.id, initJson.uploadId)).run();
					return storage.saveChunk(id, index, data);
				},
				purge: () => Promise.reject(new Error("down")),
			}),
		);

		const res = await racingApp.request(`/api/v1/notes/upload/${initJson.uploadId}/chunks/0`, {
			method: "PUT",
			headers: { "Content-Type": "application/octet-stream", "X-Chunk-Hash": sha256hex(chunk) },
			body: chunk as BodyInit,
		});

		expect(res.status).toBe(404);
		expect(pendingNoteIds()).toEqual([noteId]);
	});

	it("rejects chunk with out-of-range index", async () => {
		const { json: initJson } = await initUpload({ chunkCount: 2 });
		const chunk = chunkData("test");

		const res = await app.request(`/api/v1/notes/upload/${initJson.uploadId}/chunks/5`, {
			method: "PUT",
			headers: { "Content-Type": "application/octet-stream", "X-Chunk-Hash": sha256hex(chunk) },
			body: chunk as BodyInit,
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe("Chunk index out of range");
	});

	it("rejects complete with missing chunks", async () => {
		const { json: initJson } = await initUpload({ chunkCount: 2 });
		const chunk = chunkData("only-one");

		await app.request(`/api/v1/notes/upload/${initJson.uploadId}/chunks/0`, {
			method: "PUT",
			headers: { "Content-Type": "application/octet-stream", "X-Chunk-Hash": sha256hex(chunk) },
			body: chunk as BodyInit,
		});

		const res = await app.request(`/api/v1/notes/upload/${initJson.uploadId}/complete`, {
			method: "POST",
			headers: authHeaders(),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe("Upload incomplete");
	});

	it("rejects chunk for non-existent upload session", async () => {
		const chunk = chunkData("test");
		const res = await app.request(
			"/api/v1/notes/upload/nonexistent_session_id_padding__/chunks/0",
			{
				method: "PUT",
				headers: { "Content-Type": "application/octet-stream", "X-Chunk-Hash": sha256hex(chunk) },
				body: chunk as BodyInit,
			},
		);
		expect(res.status).toBe(404);
	});

	it("rejects double complete (409 conflict)", async () => {
		const { json: initJson } = await initUpload({ chunkCount: 1 });
		const chunk = chunkData("data");

		await app.request(`/api/v1/notes/upload/${initJson.uploadId}/chunks/0`, {
			method: "PUT",
			headers: { "Content-Type": "application/octet-stream", "X-Chunk-Hash": sha256hex(chunk) },
			body: chunk as BodyInit,
		});

		const res1 = await app.request(`/api/v1/notes/upload/${initJson.uploadId}/complete`, {
			method: "POST",
			headers: authHeaders(),
		});
		expect(res1.status).toBe(201);

		// Second complete should fail (session deleted)
		const res2 = await app.request(`/api/v1/notes/upload/${initJson.uploadId}/complete`, {
			method: "POST",
			headers: authHeaders(),
		});
		expect(res2.status).toBe(404);
	});

	it("chunk upload is idempotent (same index twice)", async () => {
		const { json: initJson } = await initUpload({ chunkCount: 1 });
		const chunk = chunkData("data");
		const hash = sha256hex(chunk);

		const res1 = await app.request(`/api/v1/notes/upload/${initJson.uploadId}/chunks/0`, {
			method: "PUT",
			headers: { "Content-Type": "application/octet-stream", "X-Chunk-Hash": hash },
			body: chunk as BodyInit,
		});
		expect(res1.status).toBe(200);

		const res2 = await app.request(`/api/v1/notes/upload/${initJson.uploadId}/chunks/0`, {
			method: "PUT",
			headers: { "Content-Type": "application/octet-stream", "X-Chunk-Hash": hash },
			body: chunk as BodyInit,
		});
		expect(res2.status).toBe(200);
	});

	it("returns 409 when note already exists on complete (race condition)", async () => {
		const { json: initJson } = await initUpload({ chunkCount: 1 });
		const chunk = chunkData("data");

		await app.request(`/api/v1/notes/upload/${initJson.uploadId}/chunks/0`, {
			method: "PUT",
			headers: { "Content-Type": "application/octet-stream", "X-Chunk-Hash": sha256hex(chunk) },
			body: chunk as BodyInit,
		});

		// Look up the upload session's noteId and pre-insert a note with that ID
		const { uploads: uploadsTable } = await import("../db/schema.js");
		const { serverEncrypt } = await import("@largerio/secret-crypto");
		const session = db
			.select()
			.from(uploadsTable)
			.where(eq(uploadsTable.id, initJson.uploadId))
			.get();
		const { encrypted, iv } = serverEncrypt(Buffer.from("test"), TEST_SERVER_KEY);
		db.insert(notesTable)
			.values({
				id: session?.noteId ?? "",
				encryptedData: encrypted,
				serverNonce: iv.toString("base64"),
				clientNonce: "nonce",
				hasPassword: false,
				deleteToken: "tok",
				fileCount: 0,
				filePath: null,
				expiresAt: new Date(Date.now() + 3_600_000),
				createdAt: new Date(),
			})
			.run();

		const res = await app.request(`/api/v1/notes/upload/${initJson.uploadId}/complete`, {
			method: "POST",
			headers: authHeaders(),
		});
		expect(res.status).toBe(409);
		expect((await res.json()).error).toBe("Upload already completed");
	});

	it("rejects empty chunk body", async () => {
		const { json: initJson } = await initUpload({ chunkCount: 1 });

		const res = await app.request(`/api/v1/notes/upload/${initJson.uploadId}/chunks/0`, {
			method: "PUT",
			headers: {
				"Content-Type": "application/octet-stream",
				"X-Chunk-Hash": sha256hex(new Uint8Array(0)),
			},
			body: new Uint8Array(0) as BodyInit,
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe("Empty chunk body");
	});

	it("rejects invalid JSON body on init", async () => {
		const res = await app.request("/api/v1/notes/upload/init", {
			method: "POST",
			headers: authHeaders({ "Content-Type": "application/json" }),
			body: "not-json{{",
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe("Malformed JSON in request body");
	});

	it("rejects invalid schema on init", async () => {
		const res = await app.request("/api/v1/notes/upload/init", {
			method: "POST",
			headers: authHeaders({ "Content-Type": "application/json" }),
			body: JSON.stringify({ chunkCount: 1 }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe("Invalid request");
	});

	it("rejects chunk with invalid (negative) index", async () => {
		const { json: initJson } = await initUpload({ chunkCount: 1 });
		const chunk = chunkData("test");

		const res = await app.request(`/api/v1/notes/upload/${initJson.uploadId}/chunks/-1`, {
			method: "PUT",
			headers: { "Content-Type": "application/octet-stream", "X-Chunk-Hash": sha256hex(chunk) },
			body: chunk as BodyInit,
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe("Invalid request");
	});

	it("rejects chunk with non-integer index", async () => {
		const { json: initJson } = await initUpload({ chunkCount: 2 });
		const chunk = chunkData("test");

		for (const badIndex of ["1.5", "12abc", "0x1"]) {
			const res = await app.request(
				`/api/v1/notes/upload/${initJson.uploadId}/chunks/${badIndex}`,
				{
					method: "PUT",
					headers: {
						"Content-Type": "application/octet-stream",
						"X-Chunk-Hash": sha256hex(chunk),
					},
					body: chunk as BodyInit,
				},
			);
			expect(res.status).toBe(400);
			expect((await res.json()).error).toBe("Invalid request");
		}
	});

	it("rejects too many chunks on init", async () => {
		// maxChunkedFileSize=524_288_000, chunkSize=4_194_304 → maxChunks=125
		// Use 200 which passes Zod (max 10000) but exceeds computed maxChunks
		const res = await app.request("/api/v1/notes/upload/init", {
			method: "POST",
			headers: authHeaders({ "Content-Type": "application/json" }),
			body: JSON.stringify(initPayload({ chunkCount: 200 })),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error).toContain("Maximum");
	});

	it("rejects oversized chunk", async () => {
		const { json: initJson } = await initUpload({ chunkCount: 1 });
		// chunkSize is 4_194_304, max is chunkSize + 17 = 4_194_321
		const oversized = new Uint8Array(4_194_322);
		const hash = sha256hex(oversized);

		const res = await app.request(`/api/v1/notes/upload/${initJson.uploadId}/chunks/0`, {
			method: "PUT",
			headers: { "Content-Type": "application/octet-stream", "X-Chunk-Hash": hash },
			body: oversized as BodyInit,
		});
		expect(res.status).toBe(413);
		expect((await res.json()).error).toBe("Chunk too large");
	});

	it("rejects a malformed upload ID before hitting the database", async () => {
		// Distinct from a well-formed but unknown session (404): a wrong-length or
		// wrong-charset id can never name a real session, so it is a 400.
		for (const badId of ["short", "x".repeat(64), "has!invalid$chars_padding_______"]) {
			const res = await app.request(`/api/v1/notes/upload/${badId}/complete`, {
				method: "POST",
				headers: authHeaders(),
			});
			expect(res.status).toBe(400);
			expect((await res.json()).error).toBe("Invalid request");
		}
	});

	it("rejects complete for non-existent upload session", async () => {
		const res = await app.request(
			"/api/v1/notes/upload/nonexistent_session_id_padding__/complete",
			{
				method: "POST",
				headers: authHeaders(),
			},
		);
		expect(res.status).toBe(404);
	});

	it("supports salt in chunked upload metadata", async () => {
		const testSalt = Buffer.from("test-salt-16b").toString("base64");
		const { json: initJson } = await initUpload({
			chunkCount: 1,
			hasPassword: true,
			salt: testSalt,
		});
		const chunk = chunkData("encrypted-with-pw");

		await app.request(`/api/v1/notes/upload/${initJson.uploadId}/chunks/0`, {
			method: "PUT",
			headers: { "Content-Type": "application/octet-stream", "X-Chunk-Hash": sha256hex(chunk) },
			body: chunk as BodyInit,
		});

		const completeRes = await app.request(`/api/v1/notes/upload/${initJson.uploadId}/complete`, {
			method: "POST",
			headers: authHeaders(),
		});
		expect(completeRes.status).toBe(201);
	});

	it("rejects PUT chunk with invalid uploadId format", async () => {
		const chunk = chunkData("test");
		const res = await app.request("/api/v1/notes/upload/invalid%20id!/chunks/0", {
			method: "PUT",
			headers: { "Content-Type": "application/octet-stream", "X-Chunk-Hash": sha256hex(chunk) },
			body: chunk as BodyInit,
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe("Invalid request");
	});

	it("rejects POST complete with invalid uploadId format", async () => {
		const res = await app.request("/api/v1/notes/upload/invalid%20id!/complete", {
			method: "POST",
			headers: authHeaders(),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe("Invalid request");
	});

	it("deduplicates concurrent uploads of the same chunk", async () => {
		const { json: initJson } = await initUpload({ chunkCount: 3 });
		const chunk = chunkData("concurrent-chunk");
		const headers = {
			"Content-Type": "application/octet-stream",
			"X-Chunk-Hash": sha256hex(chunk),
		};
		const results = await Promise.all([
			app.request(`/api/v1/notes/upload/${initJson.uploadId}/chunks/0`, {
				method: "PUT",
				headers,
				body: chunk as BodyInit,
			}),
			app.request(`/api/v1/notes/upload/${initJson.uploadId}/chunks/0`, {
				method: "PUT",
				headers,
				body: chunk as BodyInit,
			}),
			app.request(`/api/v1/notes/upload/${initJson.uploadId}/chunks/1`, {
				method: "PUT",
				headers,
				body: chunk as BodyInit,
			}),
			app.request(`/api/v1/notes/upload/${initJson.uploadId}/chunks/2`, {
				method: "PUT",
				headers,
				body: chunk as BodyInit,
			}),
		]);
		expect(results.every((r) => r.status === 200)).toBe(true);

		const { uploadChunks: table } = await import("../db/schema.js");
		const rows = db.select().from(table).where(eq(table.uploadId, initJson.uploadId)).all();
		expect(rows).toHaveLength(3);
		expect(rows.map((r) => r.chunkIndex).sort()).toEqual([0, 1, 2]);
	});

	it("returns 500 when metadata is corrupted in DB", async () => {
		const { json: initJson } = await initUpload({ chunkCount: 1 });
		const chunk = chunkData("test-chunk");
		await app.request(`/api/v1/notes/upload/${initJson.uploadId}/chunks/0`, {
			method: "PUT",
			headers: { "Content-Type": "application/octet-stream", "X-Chunk-Hash": sha256hex(chunk) },
			body: chunk as BodyInit,
		});

		const { uploads: uploadsTable } = await import("../db/schema.js");
		db.update(uploadsTable)
			.set({ metadata: "not-valid-json" })
			.where(eq(uploadsTable.id, initJson.uploadId))
			.run();

		const res = await app.request(`/api/v1/notes/upload/${initJson.uploadId}/complete`, {
			method: "POST",
			headers: authHeaders(),
		});
		expect(res.status).toBe(500);
		expect((await res.json()).error).toBe("Corrupted upload session");
	});

	it("returns 500 when metadata is valid JSON but has the wrong shape", async () => {
		const { json: initJson } = await initUpload({ chunkCount: 1 });
		const chunk = chunkData("test-chunk");
		await app.request(`/api/v1/notes/upload/${initJson.uploadId}/chunks/0`, {
			method: "PUT",
			headers: { "Content-Type": "application/octet-stream", "X-Chunk-Hash": sha256hex(chunk) },
			body: chunk as BodyInit,
		});

		const { uploads: uploadsTable } = await import("../db/schema.js");
		// Valid JSON but missing every required metadata field.
		db.update(uploadsTable)
			.set({ metadata: JSON.stringify({ unexpected: "shape" }) })
			.where(eq(uploadsTable.id, initJson.uploadId))
			.run();

		const res = await app.request(`/api/v1/notes/upload/${initJson.uploadId}/complete`, {
			method: "POST",
			headers: authHeaders(),
		});
		expect(res.status).toBe(500);
		expect((await res.json()).error).toBe("Corrupted upload session");
	});
});

describe("GET /api/v1/notes/:id/stream", () => {
	function initPayload(overrides: Record<string, unknown> = {}) {
		return {
			streamHeader: Buffer.from("test-header-24-bytes!!!").toString("base64"),
			clientNonce: Buffer.from("test-nonce-24-bytes!!!!").toString("base64"),
			hasPassword: false,
			expiresIn: 3600,
			maxReads: 0,
			fileCount: 1,
			chunkCount: 2,
			...overrides,
		};
	}

	function chunkData(content: string): Uint8Array {
		return new Uint8Array(Buffer.from(content));
	}

	function sha256hex(data: Uint8Array): string {
		return createHash("sha256").update(data).digest("hex");
	}

	async function createChunkedNote(
		overrides: Record<string, unknown> = {},
	): Promise<{ id: string; deleteToken: string }> {
		const payload = initPayload(overrides);
		const initRes = await app.request("/api/v1/notes/upload/init", {
			method: "POST",
			headers: authHeaders({ "Content-Type": "application/json" }),
			body: JSON.stringify(payload),
		});
		const { uploadId } = (await initRes.json()) as { uploadId: string };

		const chunkCount = (payload.chunkCount ?? 2) as number;
		for (let i = 0; i < chunkCount; i++) {
			const chunk = chunkData(`chunk-data-${String(i)}`);
			await app.request(`/api/v1/notes/upload/${uploadId}/chunks/${String(i)}`, {
				method: "PUT",
				headers: {
					"Content-Type": "application/octet-stream",
					"X-Chunk-Hash": sha256hex(chunk),
				},
				body: chunk as BodyInit,
			});
		}

		const completeRes = await app.request(`/api/v1/notes/upload/${uploadId}/complete`, {
			method: "POST",
			headers: authHeaders(),
		});
		return completeRes.json() as Promise<{ id: string; deleteToken: string }>;
	}

	it("streams chunked note with correct headers and length-prefix framing", async () => {
		const { id } = await createChunkedNote();

		const res = await app.request(`/api/v1/notes/${id}/stream`);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
		expect(res.headers.get("X-Stream-Header")).toBeDefined();
		expect(res.headers.get("X-Chunk-Count")).toBe("2");
		expect(res.headers.get("X-Has-Password")).toBe("false");
		expect(res.headers.get("X-File-Count")).toBe("1");
		expect(res.headers.get("X-Created-At")).toBeDefined();
		expect(res.headers.get("X-Expires-At")).toBeDefined();

		// Verify body uses length-prefix framing
		const body = new Uint8Array(await res.arrayBuffer());
		expect(body.byteLength).toBeGreaterThan(8); // At least two 4-byte length prefixes

		// Parse first frame
		const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
		const firstLen = view.getUint32(0);
		expect(firstLen).toBeGreaterThan(0);
		expect(firstLen).toBeLessThan(body.byteLength);
	});

	it("forces download and forbids MIME sniffing on stream", async () => {
		const { id } = await createChunkedNote();

		const res = await app.request(`/api/v1/notes/${id}/stream`);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Disposition")).toBe("attachment");
		expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
	});

	it("returns 400 for non-chunked note on stream endpoint", async () => {
		const { id } = await createTestNote();

		const res = await app.request(`/api/v1/notes/${id}/stream`);
		expect(res.status).toBe(400);
		const json = await res.json();
		expect(json.error).toBe("Note is not a chunked note");
	});

	it("does not consume a read when non-chunked note hits stream endpoint", async () => {
		const { id } = await createTestNote({ maxReads: 1 });

		const streamRes = await app.request(`/api/v1/notes/${id}/stream`);
		expect(streamRes.status).toBe(400);

		// readCount was not incremented, so the JSON endpoint should still succeed.
		const jsonRes = await app.request(`/api/v1/notes/${id}`);
		expect(jsonRes.status).toBe(200);
	});

	it("returns 404 for expired chunked note on stream", async () => {
		const { id } = await createChunkedNote();

		db.update(notesTable)
			.set({ expiresAt: new Date(Date.now() - 1000) })
			.where(eq(notesTable.id, id))
			.run();

		const res = await app.request(`/api/v1/notes/${id}/stream`);
		expect(res.status).toBe(404);
		const json = await res.json();
		expect(json.error).toBe("Note not found");
	});

	it("queues the purge of an expired chunked note for a retry when it fails", async () => {
		const { id } = await createChunkedNote();
		db.update(notesTable)
			.set({ expiresAt: new Date(Date.now() - 1000) })
			.where(eq(notesTable.id, id))
			.run();
		const failApp = createApp(
			db,
			stubStorage({ purge: vi.fn().mockRejectedValue(new Error("stream chunk error obj")) }),
		);

		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const res = await failApp.request(`/api/v1/notes/${id}/stream`);
		expect(res.status).toBe(404);

		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining('"msg":"storage purge failed, retry scheduled"'),
		);
		expect(pendingNoteIds()).toEqual([id]);
	});

	it("returns 404 for non-existent note on stream", async () => {
		const res = await app.request("/api/v1/notes/nonexistent1/stream");
		expect(res.status).toBe(404);
		const json = await res.json();
		expect(json.error).toBe("Note not found");
	});

	it("returns 400 for invalid note ID on stream", async () => {
		const res = await app.request("/api/v1/notes/bad!id/stream");
		expect(res.status).toBe(400);
		const json = await res.json();
		expect(json.error).toBe("Invalid request");
	});

	it("burns chunked note after stream read with maxReads=1", async () => {
		const { id } = await createChunkedNote({ maxReads: 1 });

		const res = await app.request(`/api/v1/notes/${id}/stream`);
		expect(res.status).toBe(200);
		// Consume the body to trigger the stream
		await res.arrayBuffer();

		const secondRead = await app.request(`/api/v1/notes/${id}/stream`);
		expect(secondRead.status).toBe(404);
	});

	it("streams chunked note with null maxReads (unlimited reads)", async () => {
		const { id } = await createChunkedNote();
		db.update(notesTable).set({ maxReads: null }).where(eq(notesTable.id, id)).run();

		const res = await app.request(`/api/v1/notes/${id}/stream`);
		expect(res.status).toBe(200);

		// Should still be readable after first read
		const res2 = await app.request(`/api/v1/notes/${id}/stream`);
		expect(res2.status).toBe(200);
	});

	it("includes salt header for password-protected chunked note", async () => {
		const testSalt = Buffer.from("test-salt-16bytes").toString("base64");
		const { id } = await createChunkedNote({ hasPassword: true, salt: testSalt });

		const res = await app.request(`/api/v1/notes/${id}/stream`);
		expect(res.status).toBe(200);
		expect(res.headers.get("X-Salt")).toBe(testSalt);
		expect(res.headers.get("X-Has-Password")).toBe("true");
	});

	it("streams chunks in order with read-ahead prefetching (more chunks than window)", async () => {
		const chunkCount = 6;
		const { id } = await createChunkedNote({ chunkCount });

		const res = await app.request(`/api/v1/notes/${id}/stream`);
		expect(res.status).toBe(200);
		expect(res.headers.get("X-Chunk-Count")).toBe(String(chunkCount));

		// Decode the length-prefixed framing and verify every chunk arrives
		// in order with its original (client-encrypted) content.
		const body = new Uint8Array(await res.arrayBuffer());
		const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
		const frames: string[] = [];
		let offset = 0;
		while (offset < body.byteLength) {
			const len = view.getUint32(offset);
			offset += 4;
			frames.push(Buffer.from(body.subarray(offset, offset + len)).toString());
			offset += len;
		}

		expect(frames).toEqual(Array.from({ length: chunkCount }, (_, i) => `chunk-data-${String(i)}`));
	});
});

describe("GET /api/v1/notes/:id/stream edge cases", () => {
	function chunkData(content: string): Uint8Array {
		return new Uint8Array(Buffer.from(content));
	}

	function sha256hex(data: Uint8Array): string {
		return createHash("sha256").update(data).digest("hex");
	}

	async function createChunkedNoteViaApp(
		targetApp: Hono<AppEnv>,
		chunkCount = 1,
	): Promise<{ id: string; deleteToken: string }> {
		const initRes = await targetApp.request("/api/v1/notes/upload/init", {
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
		const { uploadId } = (await initRes.json()) as { uploadId: string };

		for (let i = 0; i < chunkCount; i++) {
			const chunk = chunkData(`chunk-data-${String(i)}`);
			await targetApp.request(`/api/v1/notes/upload/${uploadId}/chunks/${String(i)}`, {
				method: "PUT",
				headers: {
					"Content-Type": "application/octet-stream",
					"X-Chunk-Hash": sha256hex(chunk),
				},
				body: chunk as BodyInit,
			});
		}

		const completeRes = await targetApp.request(`/api/v1/notes/upload/${uploadId}/complete`, {
			method: "POST",
			headers: authHeaders(),
		});
		return completeRes.json() as Promise<{ id: string; deleteToken: string }>;
	}

	it("errors the stream when a later chunk read fails mid-stream", async () => {
		const realStorage = new LocalStorage(TEST_FILES_PATH);
		// Create a 2-chunk note using real storage first
		const { id } = await createChunkedNoteViaApp(createApp(db, realStorage), 2);

		// Stream through a storage whose chunk-1 read fails (chunk 0 still works,
		// so the pre-flight check passes and headers are already sent).
		const failingStorage = overrideStorage(realStorage, {
			readChunk: (noteId, idx) =>
				idx === 0
					? realStorage.readChunk(noteId, idx)
					: Promise.reject(new Error("mid-stream read failure")),
		});
		const failApp = createApp(db, failingStorage);

		const res = await failApp.request(`/api/v1/notes/${id}/stream`);
		expect(res.status).toBe(200); // Headers committed before the failure

		// Consuming the body must surface the stream error
		let streamFailed = false;
		try {
			await res.arrayBuffer();
		} catch {
			streamFailed = true;
		}
		expect(streamFailed).toBe(true);
	});

	it("keeps a burn-after-read note whose chunk 0 is too small for an auth tag", async () => {
		const realStorage = new LocalStorage(TEST_FILES_PATH);
		// Create note using real storage first
		const { id } = await createChunkedNoteViaApp(createApp(db, realStorage));

		db.update(notesTable).set({ maxReads: 1 }).where(eq(notesTable.id, id)).run();

		// Now create an app with a storage that returns too-small chunk data
		const corruptStorage = overrideStorage(realStorage, {
			readChunk: () => Promise.resolve(Buffer.alloc(20)), // 12 IV + 8 data (< 16 auth tag)
		});
		const corruptApp = createApp(db, corruptStorage);

		// Chunk 0 is decrypted before the read counts, so this fails up front.
		const res = await corruptApp.request(`/api/v1/notes/${id}/stream`);
		expect(res.status).toBe(500);
		expect(await res.json()).toMatchObject({ error: "Failed to decrypt note" });

		const row = db.select().from(notesTable).where(eq(notesTable.id, id)).get();
		expect(row?.readCount).toBe(0);
	});

	it("holds the purge of a burned chunked note until its stream ends, then retries a failure", async () => {
		const realStorage = new LocalStorage(TEST_FILES_PATH);
		const purge = vi.fn().mockRejectedValue(new Error("chunk cleanup failure"));
		const failApp = createApp(db, overrideStorage(realStorage, { purge }));
		const { id } = await createChunkedNoteViaApp(failApp, 2);
		db.update(notesTable).set({ maxReads: 1 }).where(eq(notesTable.id, id)).run();

		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const res = await failApp.request(`/api/v1/notes/${id}/stream`);
		expect(res.status).toBe(200);

		// Burned and queued, but the cleanup job is held off for as long as a
		// slow client may still be reading.
		const [queued] = db.select().from(pendingDeletions).all();
		expect(queued?.noteId).toBe(id);
		expect(queued?.nextRetryAt.getTime()).toBeGreaterThan(Date.now() + 23 * 60 * 60_000);
		expect(queued?.nextRetryAt.getTime()).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60_000 + 1000);
		expect(purge).not.toHaveBeenCalled();

		await res.arrayBuffer();

		expect(purge).toHaveBeenCalledWith(id);
		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining('"msg":"storage purge failed, retry scheduled"'),
		);
		expect(db.select().from(pendingDeletions).all()).toHaveLength(1);
	});

	it("returns 500 when readChunk fails pre-flight with a non-404 error", async () => {
		const realStorage = new LocalStorage(TEST_FILES_PATH);
		const { id } = await createChunkedNoteViaApp(createApp(db, realStorage));

		const errorStorage = overrideStorage(realStorage, {
			readChunk: () => Promise.reject(new Error("disk read failure")),
		});
		const errorApp = createApp(db, errorStorage);

		const res = await errorApp.request(`/api/v1/notes/${id}/stream`);
		expect(res.status).toBe(500);

		const row = db.select().from(notesTable).where(eq(notesTable.id, id)).get();
		expect(row?.readCount).toBe(0);
	});

	it("returns 404 when chunk 0 is missing (StorageNotFoundError)", async () => {
		const realStorage = new LocalStorage(TEST_FILES_PATH);
		const { id } = await createChunkedNoteViaApp(createApp(db, realStorage));

		const { StorageNotFoundError } = await import("../storage/errors.js");
		const missingStorage = overrideStorage(realStorage, {
			readChunk: () => Promise.reject(new StorageNotFoundError()),
		});
		const missingApp = createApp(db, missingStorage);

		const res = await missingApp.request(`/api/v1/notes/${id}/stream`);
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "Note not found" });
	});

	it("keeps a burn-after-read note whose chunk 0 is missing", async () => {
		const realStorage = new LocalStorage(TEST_FILES_PATH);
		const { id } = await createChunkedNoteViaApp(createApp(db, realStorage));

		db.update(notesTable).set({ maxReads: 1 }).where(eq(notesTable.id, id)).run();

		const { StorageNotFoundError } = await import("../storage/errors.js");
		const missingStorage = overrideStorage(realStorage, {
			readChunk: () => Promise.reject(new StorageNotFoundError()),
			purge: vi.fn().mockResolvedValue(undefined),
		});
		const missingApp = createApp(db, missingStorage);

		const res = await missingApp.request(`/api/v1/notes/${id}/stream`);
		expect(res.status).toBe(404);

		// The read never counted, so nothing was burned or cleaned up.
		expect(missingStorage.purge).not.toHaveBeenCalled();
		expect(db.select().from(pendingDeletions).all()).toHaveLength(0);
		const row = db.select().from(notesTable).where(eq(notesTable.id, id)).get();
		expect(row?.readCount).toBe(0);
	});

	it("aborts the stream when chunk decryption throws inside the loop", async () => {
		const realStorage = new LocalStorage(TEST_FILES_PATH);
		const { id } = await createChunkedNoteViaApp(createApp(db, realStorage), 2);

		// Chunk 0 is genuine (it is decrypted before headers are sent); chunk 1
		// passes the IV+tag length check but fails AES-GCM authentication,
		// exercising the catch in the ReadableStream pull().
		const garbage = Buffer.alloc(64);
		const corruptStorage = overrideStorage(realStorage, {
			readChunk: (noteId, idx) =>
				idx === 0 ? realStorage.readChunk(noteId, idx) : Promise.resolve(garbage),
		});
		const corruptApp = createApp(db, corruptStorage);

		const res = await corruptApp.request(`/api/v1/notes/${id}/stream`);
		expect(res.status).toBe(200);
		await expect(res.arrayBuffer()).rejects.toThrow();
	});

	it("applies backpressure: reads at most the prefetch window until the client consumes", async () => {
		const realStorage = new LocalStorage(TEST_FILES_PATH);
		const chunkCount = 12;
		const { id } = await createChunkedNoteViaApp(createApp(db, realStorage), chunkCount);

		const readChunkCalls: number[] = [];
		const countingStorage = overrideStorage(realStorage, {
			readChunk: (noteId, idx) => {
				readChunkCalls.push(idx);
				return realStorage.readChunk(noteId, idx);
			},
		});
		const countingApp = createApp(db, countingStorage);

		const res = await countingApp.request(`/api/v1/notes/${id}/stream`);
		expect(res.status).toBe(200);

		// Without consuming the body, only the pre-flight read plus the read-ahead
		// window may hit storage. The old start()-loop implementation read all 12
		// chunks here regardless of the client.
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(readChunkCalls.length).toBeLessThanOrEqual(5);

		// Consuming the body drains the remaining chunks, in order and intact.
		const body = new Uint8Array(await res.arrayBuffer());
		const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
		const frames: string[] = [];
		let offset = 0;
		while (offset < body.byteLength) {
			const len = view.getUint32(offset);
			offset += 4;
			frames.push(Buffer.from(body.subarray(offset, offset + len)).toString());
			offset += len;
		}
		expect(frames).toEqual(Array.from({ length: chunkCount }, (_, i) => `chunk-data-${String(i)}`));
	});

	it("runs burn-after-read cleanup when the client cancels mid-stream", async () => {
		const realStorage = new LocalStorage(TEST_FILES_PATH);
		const { id } = await createChunkedNoteViaApp(createApp(db, realStorage), 4);

		db.update(notesTable).set({ maxReads: 1 }).where(eq(notesTable.id, id)).run();

		const purge = vi.fn().mockResolvedValue(undefined);
		const spyStorage = overrideStorage(realStorage, { purge });
		const spyApp = createApp(db, spyStorage);

		const res = await spyApp.request(`/api/v1/notes/${id}/stream`);
		expect(res.status).toBe(200);

		const reader = (res.body as ReadableStream<Uint8Array>).getReader();
		await reader.read();
		await reader.cancel();

		expect(purge).toHaveBeenCalledTimes(1);
		expect(purge).toHaveBeenCalledWith(id);
		expect(db.select().from(pendingDeletions).all()).toHaveLength(0);
	});

	it("finalizes exactly once when cancel races an in-flight chunk read", async () => {
		const realStorage = new LocalStorage(TEST_FILES_PATH);
		const { id } = await createChunkedNoteViaApp(createApp(db, realStorage), 2);

		db.update(notesTable).set({ maxReads: 1 }).where(eq(notesTable.id, id)).run();

		// Chunk 1 read stays pending until released, keeping a pull() in flight
		// while the client cancels; releasing garbage then makes that pull fail
		// after cancellation already finalized the stream.
		let releaseChunk1: (data: Buffer) => void = () => {};
		const pendingChunk1 = new Promise<Buffer>((resolve) => {
			releaseChunk1 = resolve;
		});
		const purge = vi.fn().mockResolvedValue(undefined);
		const racingStorage = overrideStorage(realStorage, {
			readChunk: (noteId, idx) => (idx === 0 ? realStorage.readChunk(noteId, idx) : pendingChunk1),
			purge,
		});
		const racingApp = createApp(db, racingStorage);

		const res = await racingApp.request(`/api/v1/notes/${id}/stream`);
		expect(res.status).toBe(200);

		// Drain chunk 0 (length prefix + data) so the next pull() awaits chunk 1.
		const reader = (res.body as ReadableStream<Uint8Array>).getReader();
		await reader.read();
		await reader.read();
		await new Promise((resolve) => setTimeout(resolve, 10));

		await reader.cancel();
		expect(purge).toHaveBeenCalledTimes(1);

		// Release the in-flight read; its pull() fails past cancellation and must
		// not run the cleanup a second time.
		releaseChunk1(Buffer.alloc(64));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(purge).toHaveBeenCalledTimes(1);
	});
});

describe("HEAD on the reads that spend", () => {
	// Hono answers a HEAD with the GET route: these used to spend a read, and
	// burn a single-read note, without delivering it.
	async function createChunkedNote(): Promise<string> {
		const initRes = await app.request("/api/v1/notes/upload/init", {
			method: "POST",
			headers: authHeaders({ "Content-Type": "application/json" }),
			body: JSON.stringify({
				streamHeader: Buffer.from("test-header-24-bytes!!!").toString("base64"),
				clientNonce: Buffer.from("test-nonce-24-bytes!!!!").toString("base64"),
				hasPassword: false,
				expiresIn: 3600,
				maxReads: 1,
				fileCount: 0,
				chunkCount: 1,
			}),
		});
		const { uploadId } = (await initRes.json()) as { uploadId: string };
		const chunk = new Uint8Array(Buffer.from("head"));
		await app.request(`/api/v1/notes/upload/${uploadId}/chunks/0`, {
			method: "PUT",
			headers: {
				"Content-Type": "application/octet-stream",
				"X-Chunk-Hash": createHash("sha256").update(chunk).digest("hex"),
			},
			body: chunk as BodyInit,
		});
		const completed = await app.request(`/api/v1/notes/upload/${uploadId}/complete`, {
			method: "POST",
		});
		return ((await completed.json()) as { id: string }).id;
	}

	it("refuses a HEAD with 405 and spends no read", async () => {
		const { id } = await createTestNote({ maxReads: 1 });
		const chunkedId = await createChunkedNote();

		for (const path of [
			`/api/v1/notes/${id}`,
			`/api/v1/notes/${id}/raw`,
			`/api/v1/notes/${chunkedId}/stream`,
		]) {
			const res = await app.request(path, { method: "HEAD" });
			expect(res.status, path).toBe(405);
			expect(res.headers.get("Allow"), path).toBe("GET");
		}

		for (const note of [id, chunkedId]) {
			const exists = await app.request(`/api/v1/notes/${note}/exists`);
			expect(await exists.json()).toMatchObject({ exists: true, readCount: 0 });
		}
		expect((await app.request(`/api/v1/notes/${id}/raw`)).status).toBe(200);
		const stream = await app.request(`/api/v1/notes/${chunkedId}/stream`);
		expect(stream.status).toBe(200);
		await stream.arrayBuffer();
	});

	it("still answers a HEAD on /exists, which spends nothing", async () => {
		const { id } = await createTestNote({ maxReads: 1 });

		const res = await app.request(`/api/v1/notes/${id}/exists`, { method: "HEAD" });

		expect(res.status).toBe(200);
		const exists = await app.request(`/api/v1/notes/${id}/exists`);
		expect(await exists.json()).toMatchObject({ exists: true, readCount: 0 });
	});
});

describe("DELETE /api/v1/notes/:id (chunked)", () => {
	function chunkData(content: string): Uint8Array {
		return new Uint8Array(Buffer.from(content));
	}

	function sha256hex(data: Uint8Array): string {
		return createHash("sha256").update(data).digest("hex");
	}

	async function createChunkedNote(): Promise<{ id: string; deleteToken: string }> {
		const initRes = await app.request("/api/v1/notes/upload/init", {
			method: "POST",
			headers: authHeaders({ "Content-Type": "application/json" }),
			body: JSON.stringify({
				streamHeader: Buffer.from("test-header-24-bytes!!!").toString("base64"),
				clientNonce: Buffer.from("test-nonce-24-bytes!!!!").toString("base64"),
				hasPassword: false,
				expiresIn: 3600,
				maxReads: 0,
				fileCount: 1,
				chunkCount: 1,
			}),
		});
		const { uploadId } = (await initRes.json()) as { uploadId: string };

		const chunk = chunkData("chunk-data-0");
		await app.request(`/api/v1/notes/upload/${uploadId}/chunks/0`, {
			method: "PUT",
			headers: {
				"Content-Type": "application/octet-stream",
				"X-Chunk-Hash": sha256hex(chunk),
			},
			body: chunk as BodyInit,
		});

		const completeRes = await app.request(`/api/v1/notes/upload/${uploadId}/complete`, {
			method: "POST",
			headers: authHeaders(),
		});
		return completeRes.json() as Promise<{ id: string; deleteToken: string }>;
	}

	it("deletes chunked note and removes chunk files", async () => {
		const { id, deleteToken } = await createChunkedNote();

		// Verify note exists
		const existsRes = await app.request(`/api/v1/notes/${id}/exists`);
		expect(existsRes.status).toBe(200);

		const deleteRes = await app.request(`/api/v1/notes/${id}`, {
			method: "DELETE",
			headers: authHeaders({ "X-Delete-Token": deleteToken }),
		});
		expect(deleteRes.status).toBe(200);
		const json = await deleteRes.json();
		expect(json.deleted).toBe(true);

		// Note should be gone
		const getRes = await app.request(`/api/v1/notes/${id}/exists`);
		expect(getRes.status).toBe(200);
		const existsJson = await getRes.json();
		expect(existsJson.exists).toBe(false);
	});

	it("queues a retry when the purge of a deleted chunked note fails", async () => {
		const failApp = createAppWithFailingPurge(db);
		const { id, deleteToken } = await createChunkedNote();

		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const deleteRes = await failApp.request(`/api/v1/notes/${id}`, {
			method: "DELETE",
			headers: authHeaders({ "X-Delete-Token": deleteToken }),
		});
		expect(deleteRes.status).toBe(200);
		expect((await deleteRes.json()).deleted).toBe(true);

		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining('"msg":"storage purge failed, retry scheduled"'),
		);
		expect(pendingNoteIds()).toEqual([id]);
	});
});

// MAX_EXPIRY and MAX_FILES_PER_NOTE were advertised by GET /api/v1/config and
// documented in the README, but never enforced: an operator who set
// MAX_EXPIRY=3600 for a retention policy saw the value echoed back while the
// server kept accepting 30-day notes.
describe("operator policy limits", () => {
	function policyApp(limits: { maxExpirySeconds: number; maxFilesPerNote: number }) {
		return createApp(db, undefined, {
			MAX_EXPIRY: String(limits.maxExpirySeconds),
			MAX_FILES_PER_NOTE: String(limits.maxFilesPerNote),
		});
	}

	it("rejects an expiry beyond the operator ceiling", async () => {
		const tight = policyApp({ maxExpirySeconds: 3600, maxFilesPerNote: 10 });

		const res = await tight.request("/api/v1/notes", {
			method: "POST",
			headers: authHeaders({ "Content-Type": "application/json" }),
			body: JSON.stringify(validBody({ expiresIn: 86_400 })),
		});

		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe("Maximum expiry is 3600 seconds");
	});

	it("accepts an expiry exactly at the ceiling", async () => {
		const tight = policyApp({ maxExpirySeconds: 3600, maxFilesPerNote: 10 });

		const res = await tight.request("/api/v1/notes", {
			method: "POST",
			headers: authHeaders({ "Content-Type": "application/json" }),
			body: JSON.stringify(validBody({ expiresIn: 3600 })),
		});

		expect(res.status).toBe(201);
	});

	it("rejects more files than the operator allows", async () => {
		const tight = policyApp({ maxExpirySeconds: 2_592_000, maxFilesPerNote: 3 });

		const res = await tight.request("/api/v1/notes", {
			method: "POST",
			headers: authHeaders({ "Content-Type": "application/json" }),
			body: JSON.stringify(validBody({ fileCount: 4 })),
		});

		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe("Maximum 3 files per note");
	});

	it("applies the same ceiling to the multipart endpoint", async () => {
		const tight = policyApp({ maxExpirySeconds: 3600, maxFilesPerNote: 10 });

		const res = await tight.request("/api/v1/notes/upload", {
			method: "POST",
			headers: authHeaders(),
			body: multipartForm(validMultipartMeta({ expiresIn: 86_400 })),
		});

		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe("Maximum expiry is 3600 seconds");
	});

	it("applies the same ceiling to chunked upload init", async () => {
		const tight = policyApp({ maxExpirySeconds: 3600, maxFilesPerNote: 10 });

		const res = await tight.request("/api/v1/notes/upload/init", {
			method: "POST",
			headers: authHeaders({ "Content-Type": "application/json" }),
			body: JSON.stringify({
				streamHeader: Buffer.from("test-header-24-bytes!!!").toString("base64"),
				clientNonce: Buffer.from("test-nonce-24-bytes!!!!").toString("base64"),
				hasPassword: false,
				expiresIn: 86_400,
				maxReads: 1,
				fileCount: 1,
				chunkCount: 2,
			}),
		});

		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe("Maximum expiry is 3600 seconds");
	});
});

// The product's central promise. The invariant currently holds by construction
// (the db.transaction callback is synchronous on a single connection), but
// nothing protected it: adding a single `await` inside that callback would open
// the window and hand the same secret to two readers, with every test green.
describe("burn-after-read under concurrent reads", () => {
	it("serves a maxReads=1 note to exactly one of two simultaneous readers", async () => {
		const { id } = await createTestNote({ maxReads: 1 });

		const [a, b] = await Promise.all([
			app.request(`/api/v1/notes/${id}`),
			app.request(`/api/v1/notes/${id}`),
		]);

		expect([a.status, b.status].sort()).toEqual([200, 404]);

		expect(db.select().from(notesTable).where(eq(notesTable.id, id)).get()).toBeUndefined();
	});

	it("honours maxReads=3 across six simultaneous readers", async () => {
		const { id } = await createTestNote({ maxReads: 3 });

		const results = await Promise.all(
			Array.from({ length: 6 }, () => app.request(`/api/v1/notes/${id}`)),
		);

		expect(results.filter((r) => r.status === 200)).toHaveLength(3);
		expect(results.filter((r) => r.status === 404)).toHaveLength(3);
	});

	it("burns exactly once on the raw endpoint too", async () => {
		const { id } = await createTestNote({ maxReads: 1 });

		const [a, b] = await Promise.all([
			app.request(`/api/v1/notes/${id}/raw`),
			app.request(`/api/v1/notes/${id}/raw`),
		]);

		expect([a.status, b.status].sort()).toEqual([200, 404]);
	});

	it("answers 404 to a reader whose payload was still loading when another burned it", async () => {
		const { id } = await createTestNote({ maxReads: 1, fileCount: 1 });

		// The payload is read before the read counts, so the other reader's burn
		// can land in between: this reader has the blob but must not serve it.
		const realStorage = new LocalStorage(TEST_FILES_PATH);
		const racingStorage = overrideStorage(realStorage, {
			read: async (key) => {
				const data = await realStorage.read(key);
				db.delete(notesTable).where(eq(notesTable.id, id)).run();
				return data;
			},
		});

		const res = await createApp(db, racingStorage).request(`/api/v1/notes/${id}`);
		expect(res.status).toBe(404);
		expect((await res.json()).error).toBe("Note not found");
	});
});

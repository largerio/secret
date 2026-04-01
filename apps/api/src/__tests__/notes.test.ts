import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppDatabase } from "../db/index.js";
import { createDatabase } from "../db/index.js";
import { createWriteAuth } from "../middleware/auth.js";
import { createNotesRoutes } from "../routes/notes.js";
import type { StorageBackend } from "../storage/index.js";
import { LocalStorage } from "../storage/local.js";

vi.mock("../routes/cap.js", () => ({
	cap: {
		validateToken: vi.fn((token: string) =>
			Promise.resolve({ success: token === "valid-cap-token" }),
		),
	},
}));

interface AppEnv {
	Variables: {
		db: AppDatabase;
		serverKey: Buffer;
		storage: StorageBackend;
		chunkSize: number;
		maxChunkedFileSize: number;
	};
}

const TEST_DB_PATH = "./data/test.db";
const TEST_FILES_PATH = "./data/test-files";
const TEST_SERVER_KEY = randomBytes(32);

let db: AppDatabase;
let app: Hono<AppEnv>;

function createApp(database: AppDatabase) {
	const storage = new LocalStorage(TEST_FILES_PATH);
	const hono = new Hono<AppEnv>();
	hono.onError((err, c) => {
		if (err instanceof HTTPException) {
			return c.json({ error: err.message }, err.status);
		}
		return c.json({ error: "Internal server error" }, 500);
	});
	hono.use("*", async (c, next) => {
		c.set("db", database);
		c.set("serverKey", TEST_SERVER_KEY);
		c.set("storage", storage);
		c.set("chunkSize", 4_194_304);
		c.set("maxChunkedFileSize", 524_288_000);
		await next();
	});
	const writeAuth = createWriteAuth([]);
	hono.use("/api/v1/notes/*", writeAuth);
	hono.route("/api/v1/notes", createNotesRoutes());
	return hono;
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
	app = createApp(db);
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

describe("POST /api/v1/notes", () => {
	it("rejects requests without Cap token or API key", async () => {
		const res = await app.request("/api/v1/notes", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(validBody()),
		});
		expect(res.status).toBe(401);
		const json = await res.json();
		expect(json.error).toBe("PoW token required");
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
		expect(json.error).toBe("Invalid API key");
	});

	it("accepts a valid API key instead of Cap token", async () => {
		const storage = new LocalStorage(TEST_FILES_PATH);
		const apiApp = new Hono<AppEnv>();
		apiApp.onError((err, c) => {
			if (err instanceof HTTPException) {
				return c.json({ error: err.message }, err.status);
			}
			return c.json({ error: "Internal server error" }, 500);
		});
		apiApp.use("*", async (c, next) => {
			c.set("db", db);
			c.set("serverKey", TEST_SERVER_KEY);
			c.set("storage", storage);
			c.set("chunkSize", 4_194_304);
			c.set("maxChunkedFileSize", 524_288_000);
			await next();
		});
		const writeAuth = createWriteAuth(["valid-api-key"]);
		apiApp.use("/api/v1/notes/*", writeAuth);
		apiApp.route("/api/v1/notes", createNotesRoutes());

		const res = await apiApp.request("/api/v1/notes", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer valid-api-key",
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
	it("rejects non-multipart body", async () => {
		const res = await app.request("/api/v1/notes/upload", {
			method: "POST",
			headers: authHeaders({ "Content-Type": "application/json" }),
			body: JSON.stringify({ invalid: true }),
		});
		expect(res.status).toBe(400);
		const json = await res.json();
		expect(json.error).toBe("Invalid multipart body");
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
		expect(json.expiresAt).toBeDefined();
	});

	it("returns maxReads 0 when database value is null", async () => {
		const { id } = await createTestNote();
		const { notes } = await import("../db/schema.js");
		const { eq } = await import("drizzle-orm");
		db.update(notes).set({ maxReads: null }).where(eq(notes.id, id)).run();

		const res = await app.request(`/api/v1/notes/${id}/exists`);
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.maxReads).toBe(0);
	});

	it("reads note with null maxReads without error", async () => {
		const { id } = await createTestNote();
		const { notes } = await import("../db/schema.js");
		const { eq } = await import("drizzle-orm");
		db.update(notes).set({ maxReads: null }).where(eq(notes.id, id)).run();

		const res = await app.request(`/api/v1/notes/${id}`);
		expect(res.status).toBe(200);
	});

	it("returns 404 for a non-existent note", async () => {
		const res = await app.request("/api/v1/notes/nonexistent1/exists");
		expect(res.status).toBe(404);
		const json = await res.json();
		expect(json.error).toBe("Note not found");
	});

	it("returns 404 for an expired note", async () => {
		const { id } = await createTestNote({ expiresIn: 300 });

		// Manually expire the note by updating the DB
		const { notes } = await import("../db/schema.js");
		const { eq } = await import("drizzle-orm");
		db.update(notes)
			.set({ expiresAt: new Date(Date.now() - 1000) })
			.where(eq(notes.id, id))
			.run();

		const res = await app.request(`/api/v1/notes/${id}/exists`);
		expect(res.status).toBe(404);
		const json = await res.json();
		expect(json.error).toBe("Note not found");
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

		expect(existsSync(filePath)).toBe(false);
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

	it("deletes file when maxReads is exceeded on file note", async () => {
		const { id } = await createTestNote({ maxReads: 1, fileCount: 1 });

		const filePath = `${TEST_FILES_PATH}/${id}`;
		expect(existsSync(filePath)).toBe(true);

		await app.request(`/api/v1/notes/${id}`);
		const secondRead = await app.request(`/api/v1/notes/${id}`);
		expect(secondRead.status).toBe(404);
		expect(existsSync(filePath)).toBe(false);
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

		const { notes } = await import("../db/schema.js");
		const { eq } = await import("drizzle-orm");
		db.update(notes)
			.set({ expiresAt: new Date(Date.now() - 1000) })
			.where(eq(notes.id, id))
			.run();

		const res = await app.request(`/api/v1/notes/${id}`);
		expect(res.status).toBe(404);
		const json = await res.json();
		expect(json.error).toBe("Note has expired");
	});

	it("returns 404 and deletes file for expired note with files", async () => {
		const { id } = await createTestNote({ expiresIn: 300, fileCount: 1 });

		const filePath = `${TEST_FILES_PATH}/${id}`;
		expect(existsSync(filePath)).toBe(true);

		const { notes } = await import("../db/schema.js");
		const { eq } = await import("drizzle-orm");
		db.update(notes)
			.set({ expiresAt: new Date(Date.now() - 1000) })
			.where(eq(notes.id, id))
			.run();

		const res = await app.request(`/api/v1/notes/${id}`);
		expect(res.status).toBe(404);
		expect(existsSync(filePath)).toBe(false);
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
		const { notes } = await import("../db/schema.js");
		const { eq } = await import("drizzle-orm");
		db.update(notes)
			.set({ encryptedData: Buffer.from("corrupted-data") })
			.where(eq(notes.id, id))
			.run();

		const res = await app.request(`/api/v1/notes/${id}`);
		expect(res.status).toBe(500);
		const json = await res.json();
		expect(json.error).toBe("Failed to decrypt note");
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

describe("storage.delete error resilience", () => {
	function createAppWithFailingStorage(database: AppDatabase) {
		const realStorage = new LocalStorage(TEST_FILES_PATH);
		const failingStorage: StorageBackend = {
			save: (id, data) => realStorage.save(id, data),
			read: (key) => realStorage.read(key),
			delete: () => Promise.reject(new Error("Simulated storage failure")),
			saveChunk: (id, index, data) => realStorage.saveChunk(id, index, data),
			readChunk: (id, index) => realStorage.readChunk(id, index),
			deleteChunks: () => Promise.reject(new Error("Simulated storage failure")),
		};
		const hono = new Hono<AppEnv>();
		hono.onError((err, c) => {
			if (err instanceof HTTPException) {
				return c.json({ error: err.message }, err.status);
			}
			return c.json({ error: "Internal server error" }, 500);
		});
		hono.use("*", async (c, next) => {
			c.set("db", database);
			c.set("serverKey", TEST_SERVER_KEY);
			c.set("storage", failingStorage);
			c.set("chunkSize", 4_194_304);
			c.set("maxChunkedFileSize", 524_288_000);
			await next();
		});
		const writeAuth = createWriteAuth([]);
		hono.use("/api/v1/notes/*", writeAuth);
		hono.route("/api/v1/notes", createNotesRoutes());
		return hono;
	}

	it("delete endpoint succeeds even when storage.delete fails", async () => {
		const { id, deleteToken } = await createTestNote({ fileCount: 1 });
		const failApp = createAppWithFailingStorage(db);

		const res = await failApp.request(`/api/v1/notes/${id}`, {
			method: "DELETE",
			headers: authHeaders({ "X-Delete-Token": deleteToken }),
		});
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.deleted).toBe(true);

		// DB record should be gone
		const getRes = await failApp.request(`/api/v1/notes/${id}`);
		expect(getRes.status).toBe(404);
	});

	it("read endpoint returns 404 for expired note even when storage.delete fails", async () => {
		const { id } = await createTestNote({ expiresIn: 300, fileCount: 1 });
		const failApp = createAppWithFailingStorage(db);

		const { notes: notesTable } = await import("../db/schema.js");
		const { eq } = await import("drizzle-orm");
		db.update(notesTable)
			.set({ expiresAt: new Date(Date.now() - 1000) })
			.where(eq(notesTable.id, id))
			.run();

		const res = await failApp.request(`/api/v1/notes/${id}`);
		expect(res.status).toBe(404);
		expect((await res.json()).error).toBe("Note has expired");
	});

	it("burn-after-read returns data even when storage.delete fails", async () => {
		const { id } = await createTestNote({ maxReads: 1, fileCount: 1 });
		const failApp = createAppWithFailingStorage(db);

		const res = await failApp.request(`/api/v1/notes/${id}`);
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.encryptedData).toBeDefined();

		// Note should still be deleted from DB
		const secondRead = await failApp.request(`/api/v1/notes/${id}`);
		expect(secondRead.status).toBe(404);
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

	it("rejects chunk with missing hash", async () => {
		const { json: initJson } = await initUpload();
		const chunk = chunkData("test");

		const res = await app.request(`/api/v1/notes/upload/${initJson.uploadId}/chunks/0`, {
			method: "PUT",
			headers: { "Content-Type": "application/octet-stream" },
			body: chunk as BodyInit,
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe("Missing X-Chunk-Hash header");
	});

	it("rejects chunk with hash mismatch", async () => {
		const { json: initJson } = await initUpload();
		const chunk = chunkData("test");

		const res = await app.request(`/api/v1/notes/upload/${initJson.uploadId}/chunks/0`, {
			method: "PUT",
			headers: { "Content-Type": "application/octet-stream", "X-Chunk-Hash": "badhash" },
			body: chunk as BodyInit,
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe("Chunk hash mismatch");
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
		expect((await res.json()).error).toContain("Missing chunks");
	});

	it("rejects chunk for non-existent upload session", async () => {
		const chunk = chunkData("test");
		const res = await app.request("/api/v1/notes/upload/nonexistent-session-id-here!!/chunks/0", {
			method: "PUT",
			headers: { "Content-Type": "application/octet-stream", "X-Chunk-Hash": sha256hex(chunk) },
			body: chunk as BodyInit,
		});
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
});

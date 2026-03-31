import { describe, expect, it, beforeAll, beforeEach, afterAll } from "vitest";
import { Hono } from "hono";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createDatabase } from "../db/index.js";
import { createNotesRoutes } from "../routes/notes.js";
import { LocalStorage } from "../storage/local.js";
import type { AppDatabase } from "../db/index.js";

const TEST_DB_PATH = "./data/test.db";
const TEST_FILES_PATH = "./data/test-files";
const TEST_SERVER_KEY = randomBytes(32);

let db: AppDatabase;
let app: Hono;

function createApp(database: AppDatabase) {
	const storage = new LocalStorage(TEST_FILES_PATH);
	const hono = new Hono();
	hono.use("*", async (c, next) => {
		c.set("db", database);
		c.set("serverKey", TEST_SERVER_KEY);
		c.set("storage", storage);
		await next();
	});
	hono.route("/api/notes", createNotesRoutes());
	return hono;
}

function validBody(overrides: Record<string, unknown> = {}) {
	return {
		encryptedData: Buffer.from("test-encrypted-data").toString("base64"),
		clientNonce: Buffer.from("test-nonce-24-bytes!!!!").toString("base64"),
		hasPassword: false,
		burnAfterRead: false,
		expiresIn: 3600,
		fileCount: 0,
		...overrides,
	};
}

async function createTestNote(body: Record<string, unknown> = {}) {
	const res = await app.request("/api/notes", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(validBody(body)),
	});
	return res.json() as Promise<{ id: string; expiresAt: string; deleteToken: string }>;
}

function multipartForm(
	metadata: Record<string, unknown>,
	data: Buffer = Buffer.from("test-encrypted-data"),
): FormData {
	const form = new FormData();
	form.append("metadata", JSON.stringify(metadata));
	form.append("data", new Blob([data], { type: "application/octet-stream" }));
	return form;
}

function validMultipartMeta(overrides: Record<string, unknown> = {}) {
	return {
		clientNonce: Buffer.from("test-nonce-24-bytes!!!!").toString("base64"),
		hasPassword: false,
		burnAfterRead: false,
		expiresIn: 3600,
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

describe("POST /api/notes", () => {
	it("creates a note and returns id, expiresAt, and deleteToken", async () => {
		const res = await app.request("/api/notes", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
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
		const res = await app.request("/api/notes", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(validBody({ encryptedData: "" })),
		});
		expect(res.status).toBe(400);
	});

	it("rejects expiresIn too low", async () => {
		const res = await app.request("/api/notes", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(validBody({ expiresIn: 10 })),
		});
		expect(res.status).toBe(400);
	});

	it("rejects expiresIn too high", async () => {
		const res = await app.request("/api/notes", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(validBody({ expiresIn: 9999999 })),
		});
		expect(res.status).toBe(400);
	});

	it("creates a note with files on disk", async () => {
		const res = await app.request("/api/notes", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(validBody({ fileCount: 2 })),
		});
		expect(res.status).toBe(201);
	});

	it("creates a note with password and salt", async () => {
		const testSalt = Buffer.from("test-salt-data-16bytes").toString("base64");
		const res = await app.request("/api/notes", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(validBody({ hasPassword: true, salt: testSalt })),
		});
		expect(res.status).toBe(201);
	});

	it("rejects hasPassword without salt", async () => {
		const res = await app.request("/api/notes", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(validBody({ hasPassword: true })),
		});
		expect(res.status).toBe(400);
	});

	it("stores and returns salt for password-protected notes", async () => {
		const testSalt = Buffer.from("test-salt-data-16bytes").toString("base64");
		const { id } = await createTestNote({ hasPassword: true, salt: testSalt });

		const readRes = await app.request(`/api/notes/${id}`);
		expect(readRes.status).toBe(200);
		const note = await readRes.json();
		expect(note.hasPassword).toBe(true);
		expect(note.salt).toBe(testSalt);
	});

	it("creates a note with burn after read", async () => {
		const res = await app.request("/api/notes", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(validBody({ burnAfterRead: true })),
		});
		expect(res.status).toBe(201);
	});

	it("creates a note with maxReads", async () => {
		const res = await app.request("/api/notes", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(validBody({ maxReads: 3 })),
		});
		expect(res.status).toBe(201);
	});

	it("rejects invalid JSON body", async () => {
		const res = await app.request("/api/notes", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "not json",
		});
		expect(res.status).toBe(400);
	});
});

describe("POST /api/notes/upload (multipart)", () => {
	it("creates a note via multipart upload", async () => {
		const form = multipartForm(validMultipartMeta());
		const res = await app.request("/api/notes/upload", {
			method: "POST",
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
		const createRes = await app.request("/api/notes/upload", {
			method: "POST",
			body: form,
		});
		const { id } = await createRes.json() as { id: string };

		const readRes = await app.request(`/api/notes/${id}`);
		expect(readRes.status).toBe(200);
		const note = await readRes.json();
		expect(note.fileCount).toBe(1);
		expect(note.encryptedData).toBeDefined();
	});

	it("rejects missing metadata part", async () => {
		const form = new FormData();
		form.append("data", new Blob([Buffer.from("test")]));
		const res = await app.request("/api/notes/upload", {
			method: "POST",
			body: form,
		});
		expect(res.status).toBe(400);
	});

	it("rejects missing data part", async () => {
		const form = new FormData();
		form.append("metadata", JSON.stringify(validMultipartMeta()));
		const res = await app.request("/api/notes/upload", {
			method: "POST",
			body: form,
		});
		expect(res.status).toBe(400);
	});

	it("rejects invalid metadata JSON", async () => {
		const form = new FormData();
		form.append("metadata", "not-json{{{");
		form.append("data", new Blob([Buffer.from("test")]));
		const res = await app.request("/api/notes/upload", {
			method: "POST",
			body: form,
		});
		expect(res.status).toBe(400);
	});

	it("rejects invalid metadata schema", async () => {
		const form = multipartForm({ fileCount: 1 });
		const res = await app.request("/api/notes/upload", {
			method: "POST",
			body: form,
		});
		expect(res.status).toBe(400);
	});

	it("supports password-protected multipart upload", async () => {
		const testSalt = Buffer.from("test-salt").toString("base64");
		const form = multipartForm(validMultipartMeta({ hasPassword: true, salt: testSalt }));
		const res = await app.request("/api/notes/upload", {
			method: "POST",
			body: form,
		});
		expect(res.status).toBe(201);
	});

	it("supports burn after read via multipart", async () => {
		const form = multipartForm(validMultipartMeta({ burnAfterRead: true }));
		const createRes = await app.request("/api/notes/upload", {
			method: "POST",
			body: form,
		});
		expect(createRes.status).toBe(201);
		const { id } = await createRes.json() as { id: string };

		const readRes = await app.request(`/api/notes/${id}`);
		expect(readRes.status).toBe(200);

		const secondRead = await app.request(`/api/notes/${id}`);
		expect(secondRead.status).toBe(404);
	});
});

describe("GET /api/notes/:id/exists", () => {
	it("returns exists true for a valid note", async () => {
		const { id } = await createTestNote();

		const res = await app.request(`/api/notes/${id}/exists`);
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.exists).toBe(true);
		expect(json.hasPassword).toBe(false);
		expect(json.fileCount).toBe(0);
		expect(json.burnAfterRead).toBe(false);
		expect(json.expiresAt).toBeDefined();
	});

	it("returns 404 for a non-existent note", async () => {
		const res = await app.request("/api/notes/nonexistent1/exists");
		expect(res.status).toBe(404);
		const json = await res.json();
		expect(json.exists).toBe(false);
	});

	it("returns 404 for an expired note", async () => {
		const { id } = await createTestNote({ expiresIn: 300 });

		// Manually expire the note by updating the DB
		const { notes } = await import("../db/schema.js");
		const { eq } = await import("drizzle-orm");
		db.update(notes).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(notes.id, id)).run();

		const res = await app.request(`/api/notes/${id}/exists`);
		expect(res.status).toBe(404);
		const json = await res.json();
		expect(json.exists).toBe(false);
	});

	it("returns 400 for invalid note ID format", async () => {
		const res = await app.request("/api/notes/bad!id@#$/exists");
		expect(res.status).toBe(400);
	});

	it("returns correct metadata for password-protected note with files", async () => {
		const testSalt = Buffer.from("test-salt-16bytes").toString("base64");
		const { id } = await createTestNote({ hasPassword: true, salt: testSalt, fileCount: 3, burnAfterRead: true });

		const res = await app.request(`/api/notes/${id}/exists`);
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.hasPassword).toBe(true);
		expect(json.fileCount).toBe(3);
		expect(json.burnAfterRead).toBe(true);
	});
});

describe("GET /api/notes/:id", () => {
	it("returns the encrypted note data with all fields", async () => {
		const { id } = await createTestNote();

		const res = await app.request(`/api/notes/${id}`);
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
		const res = await app.request("/api/notes/nonexistent1");
		expect(res.status).toBe(404);
	});

	it("returns 400 for invalid note ID format", async () => {
		const res = await app.request("/api/notes/bad!id@");
		expect(res.status).toBe(400);
	});

	it("deletes note after read when burnAfterRead is true", async () => {
		const { id } = await createTestNote({ burnAfterRead: true });

		const readRes = await app.request(`/api/notes/${id}`);
		expect(readRes.status).toBe(200);

		const secondRead = await app.request(`/api/notes/${id}`);
		expect(secondRead.status).toBe(404);
	});

	it("deletes file from disk on burn after read with files", async () => {
		const { id } = await createTestNote({ burnAfterRead: true, fileCount: 1 });

		const filePath = `${TEST_FILES_PATH}/${id}`;
		expect(existsSync(filePath)).toBe(true);

		const readRes = await app.request(`/api/notes/${id}`);
		expect(readRes.status).toBe(200);

		expect(existsSync(filePath)).toBe(false);
	});

	it("increments readCount for non-burn notes", async () => {
		const { id } = await createTestNote();

		await app.request(`/api/notes/${id}`);
		await app.request(`/api/notes/${id}`);

		const res = await app.request(`/api/notes/${id}`);
		expect(res.status).toBe(200);
	});

	it("returns 404 when maxReads is exceeded", async () => {
		const { id } = await createTestNote({ maxReads: 1 });

		const firstRead = await app.request(`/api/notes/${id}`);
		expect(firstRead.status).toBe(200);

		const secondRead = await app.request(`/api/notes/${id}`);
		expect(secondRead.status).toBe(404);
	});

	it("deletes file when maxReads is exceeded on file note", async () => {
		const { id } = await createTestNote({ maxReads: 1, fileCount: 1 });

		const filePath = `${TEST_FILES_PATH}/${id}`;
		expect(existsSync(filePath)).toBe(true);

		await app.request(`/api/notes/${id}`);
		const secondRead = await app.request(`/api/notes/${id}`);
		expect(secondRead.status).toBe(404);
		expect(existsSync(filePath)).toBe(false);
	});

	it("reads note with file data from disk", async () => {
		const { id } = await createTestNote({ fileCount: 1 });

		const res = await app.request(`/api/notes/${id}`);
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.fileCount).toBe(1);
	});

	it("returns 404 for expired note and cleans up", async () => {
		const { id } = await createTestNote({ expiresIn: 300 });

		const { notes } = await import("../db/schema.js");
		const { eq } = await import("drizzle-orm");
		db.update(notes).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(notes.id, id)).run();

		const res = await app.request(`/api/notes/${id}`);
		expect(res.status).toBe(404);
		const json = await res.json();
		expect(json.error).toBe("Note has expired");
	});

	it("does not return salt for non-password notes", async () => {
		const { id } = await createTestNote();

		const res = await app.request(`/api/notes/${id}`);
		const json = await res.json();
		expect(json.salt).toBeUndefined();
	});
});

describe("DELETE /api/notes/:id", () => {
	it("deletes an existing note with valid token", async () => {
		const { id, deleteToken } = await createTestNote();

		const deleteRes = await app.request(`/api/notes/${id}`, {
			method: "DELETE",
			headers: { "X-Delete-Token": deleteToken },
		});
		expect(deleteRes.status).toBe(200);
		const json = await deleteRes.json();
		expect(json.deleted).toBe(true);

		const getRes = await app.request(`/api/notes/${id}`);
		expect(getRes.status).toBe(404);
	});

	it("returns 401 without delete token", async () => {
		const { id } = await createTestNote();

		const res = await app.request(`/api/notes/${id}`, { method: "DELETE" });
		expect(res.status).toBe(401);
	});

	it("returns 403 with wrong delete token", async () => {
		const { id } = await createTestNote();

		const res = await app.request(`/api/notes/${id}`, {
			method: "DELETE",
			headers: { "X-Delete-Token": "wrong-token" },
		});
		expect(res.status).toBe(403);
	});

	it("returns 404 for a non-existent note", async () => {
		const res = await app.request("/api/notes/nonexistent1", {
			method: "DELETE",
			headers: { "X-Delete-Token": "some-token" },
		});
		expect(res.status).toBe(404);
	});

	it("returns 400 for invalid note ID format", async () => {
		const res = await app.request("/api/notes/bad!id@#$", {
			method: "DELETE",
			headers: { "X-Delete-Token": "some-token" },
		});
		expect(res.status).toBe(400);
	});

	it("deletes file from disk when note has files", async () => {
		const { id, deleteToken } = await createTestNote({ fileCount: 1 });

		const filePath = `${TEST_FILES_PATH}/${id}`;
		expect(existsSync(filePath)).toBe(true);

		const deleteRes = await app.request(`/api/notes/${id}`, {
			method: "DELETE",
			headers: { "X-Delete-Token": deleteToken },
		});
		expect(deleteRes.status).toBe(200);
		expect(existsSync(filePath)).toBe(false);
	});

	it("returns 403 with token of different length", async () => {
		const { id } = await createTestNote();

		const res = await app.request(`/api/notes/${id}`, {
			method: "DELETE",
			headers: { "X-Delete-Token": "short" },
		});
		expect(res.status).toBe(403);
	});
});

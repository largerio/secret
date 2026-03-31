import { describe, expect, it, beforeAll, beforeEach, afterAll } from "vitest";
import { Hono } from "hono";
import { mkdirSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createDatabase } from "../db/index.js";
import { createNotesRoutes } from "../routes/notes.js";
import type { AppDatabase } from "../db/index.js";

const TEST_DB_PATH = "./data/test.db";
const TEST_FILES_PATH = "./data/test-files";
const TEST_SERVER_KEY = randomBytes(32);

let db: AppDatabase;
let app: Hono;

function createApp(database: AppDatabase) {
	const hono = new Hono();
	hono.use("*", async (c, next) => {
		c.set("db", database);
		c.set("serverKey", TEST_SERVER_KEY);
		c.set("filesPath", TEST_FILES_PATH);
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
	db = createDatabase(TEST_DB_PATH);
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
	it("creates a note and returns id + expiresAt", async () => {
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

	it("creates a note with password flag", async () => {
		const res = await app.request("/api/notes", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(validBody({ hasPassword: true })),
		});
		expect(res.status).toBe(201);
	});

	it("stores and returns salt for password-protected notes", async () => {
		const testSalt = Buffer.from("test-salt-data-16bytes").toString("base64");
		const createRes = await app.request("/api/notes", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(validBody({ hasPassword: true, salt: testSalt })),
		});
		expect(createRes.status).toBe(201);
		const { id } = await createRes.json();

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
});

describe("GET /api/notes/:id/exists", () => {
	it("returns exists true for a valid note", async () => {
		const createRes = await app.request("/api/notes", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(validBody()),
		});
		const { id } = await createRes.json();

		const res = await app.request(`/api/notes/${id}/exists`);
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.exists).toBe(true);
		expect(json.hasPassword).toBe(false);
		expect(json.fileCount).toBe(0);
		expect(json.burnAfterRead).toBe(false);
	});

	it("returns 404 for a non-existent note", async () => {
		const res = await app.request("/api/notes/nonexistent1/exists");
		expect(res.status).toBe(404);
		const json = await res.json();
		expect(json.exists).toBe(false);
	});
});

describe("GET /api/notes/:id", () => {
	it("returns the encrypted note data", async () => {
		const createRes = await app.request("/api/notes", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(validBody()),
		});
		const { id } = await createRes.json();

		const res = await app.request(`/api/notes/${id}`);
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.encryptedData).toBeDefined();
		expect(json.clientNonce).toBeDefined();
		expect(json.hasPassword).toBe(false);
		expect(json.fileCount).toBe(0);
	});

	it("returns 404 for a non-existent note", async () => {
		const res = await app.request("/api/notes/nonexistent1");
		expect(res.status).toBe(404);
	});

	it("deletes note after read when burnAfterRead is true", async () => {
		const createRes = await app.request("/api/notes", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(validBody({ burnAfterRead: true })),
		});
		const { id } = await createRes.json();

		const readRes = await app.request(`/api/notes/${id}`);
		expect(readRes.status).toBe(200);

		const secondRead = await app.request(`/api/notes/${id}`);
		expect(secondRead.status).toBe(404);
	});

	it("increments readCount for non-burn notes", async () => {
		const createRes = await app.request("/api/notes", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(validBody()),
		});
		const { id } = await createRes.json();

		await app.request(`/api/notes/${id}`);
		await app.request(`/api/notes/${id}`);

		const res = await app.request(`/api/notes/${id}`);
		expect(res.status).toBe(200);
	});

	it("returns 404 when maxReads is exceeded", async () => {
		const createRes = await app.request("/api/notes", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(validBody({ maxReads: 1 })),
		});
		const { id } = await createRes.json();

		const firstRead = await app.request(`/api/notes/${id}`);
		expect(firstRead.status).toBe(200);

		const secondRead = await app.request(`/api/notes/${id}`);
		expect(secondRead.status).toBe(404);
	});

	it("reads note with file data from disk", async () => {
		const createRes = await app.request("/api/notes", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(validBody({ fileCount: 1 })),
		});
		const { id } = await createRes.json();

		const res = await app.request(`/api/notes/${id}`);
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.fileCount).toBe(1);
	});
});

describe("DELETE /api/notes/:id", () => {
	it("deletes an existing note", async () => {
		const createRes = await app.request("/api/notes", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(validBody()),
		});
		const { id } = await createRes.json();

		const deleteRes = await app.request(`/api/notes/${id}`, { method: "DELETE" });
		expect(deleteRes.status).toBe(200);
		const json = await deleteRes.json();
		expect(json.deleted).toBe(true);

		const getRes = await app.request(`/api/notes/${id}`);
		expect(getRes.status).toBe(404);
	});

	it("returns 404 for a non-existent note", async () => {
		const res = await app.request("/api/notes/nonexistent1", { method: "DELETE" });
		expect(res.status).toBe(404);
	});

	it("deletes file from disk when note has files", async () => {
		const createRes = await app.request("/api/notes", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(validBody({ fileCount: 1 })),
		});
		const { id } = await createRes.json();

		const deleteRes = await app.request(`/api/notes/${id}`, { method: "DELETE" });
		expect(deleteRes.status).toBe(200);
	});
});

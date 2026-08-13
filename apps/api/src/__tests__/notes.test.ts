import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppDatabase } from "../db/index.js";
import { createDatabase } from "../db/index.js";
import { pendingDeletions } from "../db/schema.js";
import { createWriteAuth } from "../middleware/auth.js";
import { createNotesRoutes } from "../routes/notes/index.js";
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
		maxExpirySeconds: number;
		maxFilesPerNote: number;
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
		expect(json.error).toBe("Unauthorized");
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
			c.set("maxExpirySeconds", 2_592_000);
			c.set("maxFilesPerNote", 10);
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

	it("returns exists false for a non-existent note", async () => {
		const res = await app.request("/api/v1/notes/nonexistent1/exists");
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.exists).toBe(false);
	});

	it("returns exists false for an expired note", async () => {
		const { id } = await createTestNote({ expiresIn: 300 });

		// Manually expire the note by updating the DB
		const { notes } = await import("../db/schema.js");
		const { eq } = await import("drizzle-orm");
		db.update(notes)
			.set({ expiresAt: new Date(Date.now() - 1000) })
			.where(eq(notes.id, id))
			.run();

		const res = await app.request(`/api/v1/notes/${id}/exists`);
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.exists).toBe(false);
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
		expect(json.error).toBe("Note not found");
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

	it("rejects a stored blob relocated from another note (AAD binding to id)", async () => {
		// Each note's server-layer blob is bound to its id via AAD. Moving one
		// note's full crypto material (blob + IV) into another row would decrypt
		// fine under the shared server key without AAD, but must fail here because
		// the row's id no longer matches the id the blob was encrypted under.
		const { id: idA } = await createTestNote();
		const { id: idB } = await createTestNote();

		const { notes } = await import("../db/schema.js");
		const { eq } = await import("drizzle-orm");
		const noteB = db.select().from(notes).where(eq(notes.id, idB)).get();
		db.update(notes)
			.set({ encryptedData: noteB?.encryptedData, serverNonce: noteB?.serverNonce })
			.where(eq(notes.id, idA))
			.run();

		const res = await app.request(`/api/v1/notes/${idA}`);
		expect(res.status).toBe(500);
		expect((await res.json()).error).toBe("Failed to decrypt note");
	});

	it("returns 404 when the stored file has been removed from disk", async () => {
		const { id } = await createTestNote({ fileCount: 1 });
		const { notes: notesTable } = await import("../db/schema.js");
		const { eq } = await import("drizzle-orm");
		const note = db.select().from(notesTable).where(eq(notesTable.id, id)).get();
		const filePath = note?.filePath ?? "";
		expect(filePath).toBeTruthy();

		const { unlink } = await import("node:fs/promises");
		await unlink(filePath);

		const res = await app.request(`/api/v1/notes/${id}`);
		expect(res.status).toBe(404);
		expect((await res.json()).error).toBe("Note not found");
	});

	it("cleans up storage when decryption fails on burn-after-read file note", async () => {
		const { id } = await createTestNote({ maxReads: 1, fileCount: 1 });

		const { notes: notesTable } = await import("../db/schema.js");
		const { eq } = await import("drizzle-orm");

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

		// Note should be deleted from DB (burn-after-read transaction) and file cleaned up
		const afterNote = db.select().from(notesTable).where(eq(notesTable.id, id)).get();
		expect(afterNote).toBeUndefined();
	});

	it("logs error when chunk cleanup fails for expired chunked note", async () => {
		const { id } = await createTestNote({ expiresIn: 300, fileCount: 1 });
		const { notes: notesTable } = await import("../db/schema.js");
		const { eq } = await import("drizzle-orm");
		db.update(notesTable)
			.set({ expiresAt: new Date(Date.now() - 1000), chunkCount: 2, streamHeader: "hdr" })
			.where(eq(notesTable.id, id))
			.run();

		// Use failing storage for chunk deletion
		const realStorage = new LocalStorage(TEST_FILES_PATH);
		const failStorage: StorageBackend = {
			save: (nid, data) => realStorage.save(nid, data),
			read: (key) => realStorage.read(key),
			delete: (key) => realStorage.delete(key),
			saveChunk: (nid, idx, data) => realStorage.saveChunk(nid, idx, data),
			readChunk: (nid, idx) => realStorage.readChunk(nid, idx),
			deleteChunks: () => Promise.reject("chunk fail string"),
		};
		const customApp = new Hono<AppEnv>();
		customApp.onError((err, c) => {
			if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
			return c.json({ error: "Internal server error" }, 500);
		});
		customApp.use("*", async (c, next) => {
			c.set("db", db);
			c.set("serverKey", TEST_SERVER_KEY);
			c.set("storage", failStorage);
			c.set("chunkSize", 4_194_304);
			c.set("maxChunkedFileSize", 524_288_000);
			c.set("maxExpirySeconds", 2_592_000);
			c.set("maxFilesPerNote", 10);
			await next();
		});
		const writeAuth = createWriteAuth([]);
		customApp.use("/api/v1/notes/*", writeAuth);
		customApp.route("/api/v1/notes", createNotesRoutes());

		const res = await customApp.request(`/api/v1/notes/${id}`);
		expect(res.status).toBe(404);
	});

	it("logs Error.message when chunk cleanup fails with Error for expired chunked note", async () => {
		const { id } = await createTestNote({ expiresIn: 300, fileCount: 1 });
		const { notes: notesTable } = await import("../db/schema.js");
		const { eq } = await import("drizzle-orm");
		db.update(notesTable)
			.set({ expiresAt: new Date(Date.now() - 1000), chunkCount: 2, streamHeader: "hdr" })
			.where(eq(notesTable.id, id))
			.run();

		const realStorage = new LocalStorage(TEST_FILES_PATH);
		const failStorage: StorageBackend = {
			save: (nid, data) => realStorage.save(nid, data),
			read: (key) => realStorage.read(key),
			delete: (key) => realStorage.delete(key),
			saveChunk: (nid, idx, data) => realStorage.saveChunk(nid, idx, data),
			readChunk: (nid, idx) => realStorage.readChunk(nid, idx),
			deleteChunks: () => Promise.reject(new Error("chunk fail error")),
		};
		const customApp = new Hono<AppEnv>();
		customApp.onError((err, c) => {
			if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
			return c.json({ error: "Internal server error" }, 500);
		});
		customApp.use("*", async (c, next) => {
			c.set("db", db);
			c.set("serverKey", TEST_SERVER_KEY);
			c.set("storage", failStorage);
			c.set("chunkSize", 4_194_304);
			c.set("maxChunkedFileSize", 524_288_000);
			c.set("maxExpirySeconds", 2_592_000);
			c.set("maxFilesPerNote", 10);
			await next();
		});
		const writeAuth = createWriteAuth([]);
		customApp.use("/api/v1/notes/*", writeAuth);
		customApp.route("/api/v1/notes", createNotesRoutes());

		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const res = await customApp.request(`/api/v1/notes/${id}`);
		expect(res.status).toBe(404);

		// The row is gone but its chunks are not: the failure must be recorded for
		// retry, otherwise the objects are orphaned in storage forever.
		expect(consoleSpy).toHaveBeenCalledWith(
			`[deletions] Storage delete failed for note ${id}, scheduling retry: chunk fail error`,
		);
		expect(db.select().from(pendingDeletions).all()).toHaveLength(1);
		consoleSpy.mockRestore();
	});

	it("returns 404 and cleans up chunks for expired chunked note", async () => {
		const { id } = await createTestNote({ expiresIn: 300, fileCount: 1 });
		const { notes: notesTable } = await import("../db/schema.js");
		const { eq } = await import("drizzle-orm");
		db.update(notesTable)
			.set({ expiresAt: new Date(Date.now() - 1000), chunkCount: 2, streamHeader: "hdr" })
			.where(eq(notesTable.id, id))
			.run();

		const res = await app.request(`/api/v1/notes/${id}`);
		expect(res.status).toBe(404);
		expect((await res.json()).error).toBe("Note not found");
	});

	// A chunked note stores an empty `encryptedData` blob, so serving it from an
	// inline endpoint used to increment the read counter, fail to decrypt, and
	// then delete the row AND its chunks in the cleanup path — destroying the
	// note and answering 500. The shape check must run before the read is burned.
	it("rejects a chunked note on the JSON endpoint without consuming a read", async () => {
		const { id } = await createTestNote({ maxReads: 1, fileCount: 0 });
		const { notes: notesTable } = await import("../db/schema.js");
		const { eq } = await import("drizzle-orm");
		db.update(notesTable)
			.set({ chunkCount: 1, streamHeader: "hdr" })
			.where(eq(notesTable.id, id))
			.run();

		const res = await app.request(`/api/v1/notes/${id}`);
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe("Note is chunked; read it from /:id/stream");

		const row = db.select().from(notesTable).where(eq(notesTable.id, id)).get();
		expect(row).toBeDefined();
		expect(row?.readCount).toBe(0);
	});

	it("rejects a chunked note on the raw endpoint without consuming a read", async () => {
		const { id } = await createTestNote({ maxReads: 1, fileCount: 0 });
		const { notes: notesTable } = await import("../db/schema.js");
		const { eq } = await import("drizzle-orm");
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
			c.set("maxExpirySeconds", 2_592_000);
			c.set("maxFilesPerNote", 10);
			await next();
		});
		const writeAuth = createWriteAuth([]);
		hono.use("/api/v1/notes/*", writeAuth);
		hono.route("/api/v1/notes", createNotesRoutes());
		return hono;
	}

	it("reclaims the stored blob when the insert fails", async () => {
		// The blob is written before the row exists. Without compensation a failed
		// insert leaves it referenced by nothing: no `notes` row for the cleanup
		// job, no `pending_deletions` entry — an orphan that never goes away.
		const storage = new LocalStorage(TEST_FILES_PATH);
		const deleted: string[] = [];
		const trackingStorage: StorageBackend = {
			...storage,
			save: (id, data) => storage.save(id, data),
			delete: (key) => {
				deleted.push(key);
				return storage.delete(key);
			},
			deleteChunks: (id, count) => storage.deleteChunks(id, count),
			read: (key) => storage.read(key),
			saveChunk: (id, index, data) => storage.saveChunk(id, index, data),
			readChunk: (id, index) => storage.readChunk(id, index),
		};

		// Imported lazily: a static import would evaluate the shared Zod schemas
		// before @hono/zod-openapi extends Zod with .openapi().
		const { insertNote } = await import("../routes/notes/helpers.js");

		const brokenDb = {
			...db,
			insert: () => ({
				values: () => ({
					run: () => {
						throw new Error("database or disk is full");
					},
				}),
			}),
		} as unknown as AppDatabase;

		await expect(
			insertNote(brokenDb, TEST_SERVER_KEY, trackingStorage, {
				clientBlob: Buffer.from("payload"),
				clientNonce: "nonce",
				hasPassword: false,
				expiresIn: 3600,
				maxReads: 1,
				fileCount: 1,
				salt: null,
				quotaBytes: 0,
			}),
		).rejects.toThrow("database or disk is full");

		expect(deleted).toHaveLength(1);

		// A text-only note stores no blob, so there is nothing to reclaim.
		deleted.length = 0;
		await expect(
			insertNote(brokenDb, TEST_SERVER_KEY, trackingStorage, {
				clientBlob: Buffer.from("payload"),
				clientNonce: "nonce",
				hasPassword: false,
				expiresIn: 3600,
				maxReads: 1,
				fileCount: 0,
				salt: null,
				quotaBytes: 0,
			}),
		).rejects.toThrow("database or disk is full");

		expect(deleted).toHaveLength(0);
	});

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
		expect((await res.json()).error).toBe("Note not found");
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

	it("handles non-Error rejection from storage.delete gracefully", async () => {
		const realStorage = new LocalStorage(TEST_FILES_PATH);
		const stringFailStorage: StorageBackend = {
			save: (id, data) => realStorage.save(id, data),
			read: (key) => realStorage.read(key),
			delete: () => Promise.reject("string error"),
			saveChunk: (id, index, data) => realStorage.saveChunk(id, index, data),
			readChunk: (id, index) => realStorage.readChunk(id, index),
			deleteChunks: () => Promise.reject("chunk string error"),
		};
		const hono = new Hono<AppEnv>();
		hono.onError((err, c) => {
			if (err instanceof HTTPException) {
				return c.json({ error: err.message }, err.status);
			}
			return c.json({ error: "Internal server error" }, 500);
		});
		hono.use("*", async (c, next) => {
			c.set("db", db);
			c.set("serverKey", TEST_SERVER_KEY);
			c.set("storage", stringFailStorage);
			c.set("chunkSize", 4_194_304);
			c.set("maxChunkedFileSize", 524_288_000);
			c.set("maxExpirySeconds", 2_592_000);
			c.set("maxFilesPerNote", 10);
			await next();
		});
		const writeAuth = createWriteAuth([]);
		hono.use("/api/v1/notes/*", writeAuth);
		hono.route("/api/v1/notes", createNotesRoutes());

		// Test delete with non-Error rejection
		const { id, deleteToken } = await createTestNote({ fileCount: 1 });
		const res = await hono.request(`/api/v1/notes/${id}`, {
			method: "DELETE",
			headers: authHeaders({ "X-Delete-Token": deleteToken }),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).deleted).toBe(true);

		// Test expired note read with non-Error rejection
		const { id: id2 } = await createTestNote({ expiresIn: 300, fileCount: 1 });
		const { notes: notesTable } = await import("../db/schema.js");
		const { eq: eqFn } = await import("drizzle-orm");
		db.update(notesTable)
			.set({ expiresAt: new Date(Date.now() - 1000) })
			.where(eqFn(notesTable.id, id2))
			.run();
		const res2 = await hono.request(`/api/v1/notes/${id2}`);
		expect(res2.status).toBe(404);

		// Test burn-after-read with non-Error rejection
		const { id: id3 } = await createTestNote({ maxReads: 1, fileCount: 1 });
		const res3 = await hono.request(`/api/v1/notes/${id3}`);
		expect(res3.status).toBe(200);

		// Test delete of chunked note with non-Error rejection from deleteChunks
		const { notes: nt } = await import("../db/schema.js");
		const { eq: e } = await import("drizzle-orm");
		const { id: id4, deleteToken: dt4 } = await createTestNote({ fileCount: 1 });
		db.update(nt).set({ chunkCount: 2, streamHeader: "hdr" }).where(e(nt.id, id4)).run();
		const res4 = await hono.request(`/api/v1/notes/${id4}`, {
			method: "DELETE",
			headers: authHeaders({ "X-Delete-Token": dt4 }),
		});
		expect(res4.status).toBe(200);
		expect((await res4.json()).deleted).toBe(true);
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
		const { uploads: uploadsTable, notes: notesTable } = await import("../db/schema.js");
		const { eq } = await import("drizzle-orm");
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
				burnAfterRead: false,
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
		expect((await res.json()).error).toBe("Invalid JSON body");
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
		expect((await res.json()).error).toBe("Invalid chunk index");
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
			expect((await res.json()).error).toBe("Invalid chunk index");
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
			expect((await res.json()).error).toBe("Invalid upload ID");
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
		expect((await res.json()).error).toBe("Invalid upload ID");
	});

	it("rejects POST complete with invalid uploadId format", async () => {
		const res = await app.request("/api/v1/notes/upload/invalid%20id!/complete", {
			method: "POST",
			headers: authHeaders(),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe("Invalid upload ID");
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
		const { eq } = await import("drizzle-orm");
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
		const { eq } = await import("drizzle-orm");
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
		const { eq } = await import("drizzle-orm");
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

		const { notes: notesTable } = await import("../db/schema.js");
		const { eq } = await import("drizzle-orm");
		db.update(notesTable)
			.set({ expiresAt: new Date(Date.now() - 1000) })
			.where(eq(notesTable.id, id))
			.run();

		const res = await app.request(`/api/v1/notes/${id}/stream`);
		expect(res.status).toBe(404);
		const json = await res.json();
		expect(json.error).toBe("Note not found");
	});

	it("logs error when chunk cleanup fails for expired chunked note on stream", async () => {
		const { id } = await createChunkedNote();
		const { notes: notesTable } = await import("../db/schema.js");
		const { eq } = await import("drizzle-orm");
		db.update(notesTable)
			.set({ expiresAt: new Date(Date.now() - 1000) })
			.where(eq(notesTable.id, id))
			.run();

		const failStorage: StorageBackend = {
			save: vi.fn(),
			read: vi.fn(),
			delete: vi.fn(),
			saveChunk: vi.fn(),
			readChunk: vi.fn(),
			deleteChunks: vi.fn().mockRejectedValue("stream chunk fail string"),
		};
		const failApp = new Hono<AppEnv>();
		failApp.onError((err, c) => {
			if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
			return c.json({ error: "Internal server error" }, 500);
		});
		failApp.use("*", async (c, next) => {
			c.set("db", db);
			c.set("serverKey", TEST_SERVER_KEY);
			c.set("storage", failStorage);
			c.set("chunkSize", 4_194_304);
			c.set("maxChunkedFileSize", 524_288_000);
			c.set("maxExpirySeconds", 2_592_000);
			c.set("maxFilesPerNote", 10);
			await next();
		});
		failApp.route("/api/v1/notes", createNotesRoutes());

		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const res = await failApp.request(`/api/v1/notes/${id}/stream`);
		expect(res.status).toBe(404);

		expect(consoleSpy).toHaveBeenCalledWith(
			`[deletions] Storage delete failed for note ${id}, scheduling retry: stream chunk fail string`,
		);
		consoleSpy.mockRestore();
	});

	it("logs Error.message when chunk cleanup fails with Error for expired note on stream", async () => {
		const { id } = await createChunkedNote();
		const { notes: notesTable } = await import("../db/schema.js");
		const { eq } = await import("drizzle-orm");
		db.update(notesTable)
			.set({ expiresAt: new Date(Date.now() - 1000) })
			.where(eq(notesTable.id, id))
			.run();

		const failStorage: StorageBackend = {
			save: vi.fn(),
			read: vi.fn(),
			delete: vi.fn(),
			saveChunk: vi.fn(),
			readChunk: vi.fn(),
			deleteChunks: vi.fn().mockRejectedValue(new Error("stream chunk error obj")),
		};
		const errApp = new Hono<AppEnv>();
		errApp.onError((err, c) => {
			if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
			return c.json({ error: "Internal server error" }, 500);
		});
		errApp.use("*", async (c, next) => {
			c.set("db", db);
			c.set("serverKey", TEST_SERVER_KEY);
			c.set("storage", failStorage);
			c.set("chunkSize", 4_194_304);
			c.set("maxChunkedFileSize", 524_288_000);
			c.set("maxExpirySeconds", 2_592_000);
			c.set("maxFilesPerNote", 10);
			await next();
		});
		errApp.route("/api/v1/notes", createNotesRoutes());

		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const res = await errApp.request(`/api/v1/notes/${id}/stream`);
		expect(res.status).toBe(404);

		expect(consoleSpy).toHaveBeenCalledWith(
			`[deletions] Storage delete failed for note ${id}, scheduling retry: stream chunk error obj`,
		);
		consoleSpy.mockRestore();
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
		expect(json.error).toBe("Invalid note ID");
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
		const { notes: notesTable } = await import("../db/schema.js");
		const { eq } = await import("drizzle-orm");
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

	function createAppWithCustomStorage(database: AppDatabase, storage: StorageBackend) {
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
			c.set("maxExpirySeconds", 2_592_000);
			c.set("maxFilesPerNote", 10);
			await next();
		});
		const writeAuth = createWriteAuth([]);
		hono.use("/api/v1/notes/*", writeAuth);
		hono.route("/api/v1/notes", createNotesRoutes());
		return hono;
	}

	async function createChunkedNoteViaApp(
		targetApp: ReturnType<typeof createAppWithCustomStorage>,
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
		const { id } = await createChunkedNoteViaApp(createAppWithCustomStorage(db, realStorage), 2);

		// Stream through a storage whose chunk-1 read fails (chunk 0 still works,
		// so the pre-flight check passes and headers are already sent).
		const failingStorage: StorageBackend = {
			save: (noteId, data) => realStorage.save(noteId, data),
			read: (key) => realStorage.read(key),
			delete: (key) => realStorage.delete(key),
			saveChunk: (noteId, idx, data) => realStorage.saveChunk(noteId, idx, data),
			readChunk: (noteId, idx) =>
				idx === 0
					? realStorage.readChunk(noteId, idx)
					: Promise.reject(new Error("mid-stream read failure")),
			deleteChunks: (noteId, cnt) => realStorage.deleteChunks(noteId, cnt),
		};
		const failApp = createAppWithCustomStorage(db, failingStorage);

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

	it("handles corrupted chunk data (too small for auth tag)", async () => {
		const realStorage = new LocalStorage(TEST_FILES_PATH);
		// Create note using real storage first
		const { id } = await createChunkedNoteViaApp(createAppWithCustomStorage(db, realStorage));

		// Now create an app with a storage that returns too-small chunk data
		const corruptStorage: StorageBackend = {
			save: (noteId, data) => realStorage.save(noteId, data),
			read: (key) => realStorage.read(key),
			delete: (key) => realStorage.delete(key),
			saveChunk: (noteId, idx, data) => realStorage.saveChunk(noteId, idx, data),
			readChunk: () => Promise.resolve(Buffer.alloc(20)), // 12 IV + 8 data (< 16 auth tag)
			deleteChunks: (noteId, cnt) => realStorage.deleteChunks(noteId, cnt),
		};
		const corruptApp = createAppWithCustomStorage(db, corruptStorage);

		const res = await corruptApp.request(`/api/v1/notes/${id}/stream`);
		expect(res.status).toBe(200); // Headers sent before stream starts
		// The stream should error, but we can still consume and verify it errored
		try {
			await res.arrayBuffer();
		} catch {
			// Expected — stream errored with "Invalid chunk data"
		}
	});

	it("logs error when deleteChunks fails during burn-after-read stream", async () => {
		const realStorage = new LocalStorage(TEST_FILES_PATH);
		const failDeleteChunksStorage: StorageBackend = {
			save: (noteId, data) => realStorage.save(noteId, data),
			read: (key) => realStorage.read(key),
			delete: (key) => realStorage.delete(key),
			saveChunk: (noteId, idx, data) => realStorage.saveChunk(noteId, idx, data),
			readChunk: (noteId, idx) => realStorage.readChunk(noteId, idx),
			deleteChunks: () => Promise.reject(new Error("chunk cleanup failure")),
		};
		const failApp = createAppWithCustomStorage(db, failDeleteChunksStorage);

		// Create note with maxReads=1 (burn-after-read)
		const { id } = await createChunkedNoteViaApp(failApp);
		// Update to burn-after-read
		const { notes: notesTable } = await import("../db/schema.js");
		const { eq } = await import("drizzle-orm");
		db.update(notesTable)
			.set({ maxReads: 1, burnAfterRead: true })
			.where(eq(notesTable.id, id))
			.run();

		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const res = await failApp.request(`/api/v1/notes/${id}/stream`);
		expect(res.status).toBe(200);
		await res.arrayBuffer();

		expect(consoleSpy).toHaveBeenCalledWith(
			`[deletions] Storage delete failed for note ${id}, scheduling retry: chunk cleanup failure`,
		);
		consoleSpy.mockRestore();
	});

	it("logs non-Error when deleteChunks fails with string during burn-after-read stream", async () => {
		const realStorage = new LocalStorage(TEST_FILES_PATH);
		const failStorage: StorageBackend = {
			save: (noteId, data) => realStorage.save(noteId, data),
			read: (key) => realStorage.read(key),
			delete: (key) => realStorage.delete(key),
			saveChunk: (noteId, idx, data) => realStorage.saveChunk(noteId, idx, data),
			readChunk: (noteId, idx) => realStorage.readChunk(noteId, idx),
			deleteChunks: () => Promise.reject("string delete error"),
		};
		const failApp = createAppWithCustomStorage(db, failStorage);

		const { id } = await createChunkedNoteViaApp(failApp);
		const { notes: notesTable } = await import("../db/schema.js");
		const { eq } = await import("drizzle-orm");
		db.update(notesTable)
			.set({ maxReads: 1, burnAfterRead: true })
			.where(eq(notesTable.id, id))
			.run();

		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const res = await failApp.request(`/api/v1/notes/${id}/stream`);
		expect(res.status).toBe(200);
		await res.arrayBuffer();

		expect(consoleSpy).toHaveBeenCalledWith(
			`[deletions] Storage delete failed for note ${id}, scheduling retry: string delete error`,
		);
		consoleSpy.mockRestore();
	});

	it("returns 500 when readChunk fails pre-flight with a non-404 error", async () => {
		const realStorage = new LocalStorage(TEST_FILES_PATH);
		const { id } = await createChunkedNoteViaApp(createAppWithCustomStorage(db, realStorage));

		const errorStorage: StorageBackend = {
			save: (noteId, data) => realStorage.save(noteId, data),
			read: (key) => realStorage.read(key),
			delete: (key) => realStorage.delete(key),
			saveChunk: (noteId, idx, data) => realStorage.saveChunk(noteId, idx, data),
			readChunk: () => Promise.reject(new Error("disk read failure")),
			deleteChunks: (noteId, cnt) => realStorage.deleteChunks(noteId, cnt),
		};
		const errorApp = createAppWithCustomStorage(db, errorStorage);

		const res = await errorApp.request(`/api/v1/notes/${id}/stream`);
		expect(res.status).toBe(500);
	});

	it("returns 404 when chunk 0 is missing (StorageNotFoundError)", async () => {
		const realStorage = new LocalStorage(TEST_FILES_PATH);
		const { id } = await createChunkedNoteViaApp(createAppWithCustomStorage(db, realStorage));

		const { StorageNotFoundError } = await import("../storage/errors.js");
		const missingStorage: StorageBackend = {
			save: (noteId, data) => realStorage.save(noteId, data),
			read: (key) => realStorage.read(key),
			delete: (key) => realStorage.delete(key),
			saveChunk: (noteId, idx, data) => realStorage.saveChunk(noteId, idx, data),
			readChunk: () => Promise.reject(new StorageNotFoundError()),
			deleteChunks: (noteId, cnt) => realStorage.deleteChunks(noteId, cnt),
		};
		const missingApp = createAppWithCustomStorage(db, missingStorage);

		const res = await missingApp.request(`/api/v1/notes/${id}/stream`);
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "Note not found" });
	});

	it("schedules cleanup when burn-after-read note has missing chunk 0", async () => {
		const realStorage = new LocalStorage(TEST_FILES_PATH);
		const { id } = await createChunkedNoteViaApp(createAppWithCustomStorage(db, realStorage));

		const { notes: notesTable } = await import("../db/schema.js");
		const { eq } = await import("drizzle-orm");
		db.update(notesTable)
			.set({ maxReads: 1, burnAfterRead: true })
			.where(eq(notesTable.id, id))
			.run();

		const { StorageNotFoundError } = await import("../storage/errors.js");
		const missingStorage: StorageBackend = {
			save: (noteId, data) => realStorage.save(noteId, data),
			read: (key) => realStorage.read(key),
			delete: (key) => realStorage.delete(key),
			saveChunk: (noteId, idx, data) => realStorage.saveChunk(noteId, idx, data),
			readChunk: () => Promise.reject(new StorageNotFoundError()),
			deleteChunks: vi.fn().mockResolvedValue(undefined),
		};
		const missingApp = createAppWithCustomStorage(db, missingStorage);

		const res = await missingApp.request(`/api/v1/notes/${id}/stream`);
		expect(res.status).toBe(404);
		expect(missingStorage.deleteChunks).toHaveBeenCalledWith(id, expect.any(Number));
	});

	it("aborts the stream when chunk decryption throws inside the loop", async () => {
		const realStorage = new LocalStorage(TEST_FILES_PATH);
		const { id } = await createChunkedNoteViaApp(createAppWithCustomStorage(db, realStorage));

		// Return a buffer that passes the IV+tag length check but fails AES-GCM
		// authentication, exercising the catch in the ReadableStream pull().
		const garbage = Buffer.alloc(64);
		const corruptStorage: StorageBackend = {
			save: (noteId, data) => realStorage.save(noteId, data),
			read: (key) => realStorage.read(key),
			delete: (key) => realStorage.delete(key),
			saveChunk: (noteId, idx, data) => realStorage.saveChunk(noteId, idx, data),
			readChunk: () => Promise.resolve(garbage),
			deleteChunks: (noteId, cnt) => realStorage.deleteChunks(noteId, cnt),
		};
		const corruptApp = createAppWithCustomStorage(db, corruptStorage);

		const res = await corruptApp.request(`/api/v1/notes/${id}/stream`);
		expect(res.status).toBe(200);
		await expect(res.arrayBuffer()).rejects.toThrow();
	});

	it("applies backpressure: reads at most the prefetch window until the client consumes", async () => {
		const realStorage = new LocalStorage(TEST_FILES_PATH);
		const chunkCount = 12;
		const { id } = await createChunkedNoteViaApp(
			createAppWithCustomStorage(db, realStorage),
			chunkCount,
		);

		const readChunkCalls: number[] = [];
		const countingStorage: StorageBackend = {
			save: (noteId, data) => realStorage.save(noteId, data),
			read: (key) => realStorage.read(key),
			delete: (key) => realStorage.delete(key),
			saveChunk: (noteId, idx, data) => realStorage.saveChunk(noteId, idx, data),
			readChunk: (noteId, idx) => {
				readChunkCalls.push(idx);
				return realStorage.readChunk(noteId, idx);
			},
			deleteChunks: (noteId, cnt) => realStorage.deleteChunks(noteId, cnt),
		};
		const countingApp = createAppWithCustomStorage(db, countingStorage);

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
		const { id } = await createChunkedNoteViaApp(createAppWithCustomStorage(db, realStorage), 4);

		const { notes: notesTable } = await import("../db/schema.js");
		const { eq } = await import("drizzle-orm");
		db.update(notesTable)
			.set({ maxReads: 1, burnAfterRead: true })
			.where(eq(notesTable.id, id))
			.run();

		const deleteChunks = vi.fn().mockResolvedValue(undefined);
		const spyStorage: StorageBackend = {
			save: (noteId, data) => realStorage.save(noteId, data),
			read: (key) => realStorage.read(key),
			delete: (key) => realStorage.delete(key),
			saveChunk: (noteId, idx, data) => realStorage.saveChunk(noteId, idx, data),
			readChunk: (noteId, idx) => realStorage.readChunk(noteId, idx),
			deleteChunks,
		};
		const spyApp = createAppWithCustomStorage(db, spyStorage);

		const res = await spyApp.request(`/api/v1/notes/${id}/stream`);
		expect(res.status).toBe(200);

		const reader = (res.body as ReadableStream<Uint8Array>).getReader();
		await reader.read();
		await reader.cancel();

		expect(deleteChunks).toHaveBeenCalledTimes(1);
		expect(deleteChunks).toHaveBeenCalledWith(id, 4);
	});

	it("finalizes exactly once when cancel races an in-flight chunk read", async () => {
		const realStorage = new LocalStorage(TEST_FILES_PATH);
		const { id } = await createChunkedNoteViaApp(createAppWithCustomStorage(db, realStorage), 2);

		const { notes: notesTable } = await import("../db/schema.js");
		const { eq } = await import("drizzle-orm");
		db.update(notesTable)
			.set({ maxReads: 1, burnAfterRead: true })
			.where(eq(notesTable.id, id))
			.run();

		// Chunk 1 read stays pending until released, keeping a pull() in flight
		// while the client cancels; releasing garbage then makes that pull fail
		// after cancellation already finalized the stream.
		let releaseChunk1: (data: Buffer) => void = () => {};
		const pendingChunk1 = new Promise<Buffer>((resolve) => {
			releaseChunk1 = resolve;
		});
		const deleteChunks = vi.fn().mockResolvedValue(undefined);
		const racingStorage: StorageBackend = {
			save: (noteId, data) => realStorage.save(noteId, data),
			read: (key) => realStorage.read(key),
			delete: (key) => realStorage.delete(key),
			saveChunk: (noteId, idx, data) => realStorage.saveChunk(noteId, idx, data),
			readChunk: (noteId, idx) => (idx === 0 ? realStorage.readChunk(noteId, idx) : pendingChunk1),
			deleteChunks,
		};
		const racingApp = createAppWithCustomStorage(db, racingStorage);

		const res = await racingApp.request(`/api/v1/notes/${id}/stream`);
		expect(res.status).toBe(200);

		// Drain chunk 0 (length prefix + data) so the next pull() awaits chunk 1.
		const reader = (res.body as ReadableStream<Uint8Array>).getReader();
		await reader.read();
		await reader.read();
		await new Promise((resolve) => setTimeout(resolve, 10));

		await reader.cancel();
		expect(deleteChunks).toHaveBeenCalledTimes(1);

		// Release the in-flight read; its pull() fails past cancellation and must
		// not run the cleanup a second time.
		releaseChunk1(Buffer.alloc(64));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(deleteChunks).toHaveBeenCalledTimes(1);
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

	it("logs error when storage.deleteChunks fails during delete", async () => {
		const realStorage = new LocalStorage(TEST_FILES_PATH);
		const failStorage: StorageBackend = {
			save: (id, data) => realStorage.save(id, data),
			read: (key) => realStorage.read(key),
			delete: (key) => realStorage.delete(key),
			saveChunk: (id, idx, data) => realStorage.saveChunk(id, idx, data),
			readChunk: (id, idx) => realStorage.readChunk(id, idx),
			deleteChunks: () => Promise.reject(new Error("chunk delete failure")),
		};

		const failApp = new Hono<AppEnv>();
		failApp.onError((err, c) => {
			if (err instanceof HTTPException) {
				return c.json({ error: err.message }, err.status);
			}
			return c.json({ error: "Internal server error" }, 500);
		});
		failApp.use("*", async (c, next) => {
			c.set("db", db);
			c.set("serverKey", TEST_SERVER_KEY);
			c.set("storage", failStorage);
			c.set("chunkSize", 4_194_304);
			c.set("maxChunkedFileSize", 524_288_000);
			c.set("maxExpirySeconds", 2_592_000);
			c.set("maxFilesPerNote", 10);
			await next();
		});
		const writeAuth = createWriteAuth([]);
		failApp.use("/api/v1/notes/*", writeAuth);
		failApp.route("/api/v1/notes", createNotesRoutes());

		// Create chunked note with regular app (which uses real storage for saveChunk)
		const { id, deleteToken } = await createChunkedNote();

		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const deleteRes = await failApp.request(`/api/v1/notes/${id}`, {
			method: "DELETE",
			headers: authHeaders({ "X-Delete-Token": deleteToken }),
		});
		expect(deleteRes.status).toBe(200);
		const json = await deleteRes.json();
		expect(json.deleted).toBe(true);

		expect(consoleSpy).toHaveBeenCalledWith(
			`[deletions] Storage delete failed for note ${id}, scheduling retry: chunk delete failure`,
		);
		consoleSpy.mockRestore();
	});
});

// MAX_EXPIRY and MAX_FILES_PER_NOTE were advertised by GET /api/v1/config and
// documented in the README, but never enforced: an operator who set
// MAX_EXPIRY=3600 for a retention policy saw the value echoed back while the
// server kept accepting 30-day notes.
describe("operator policy limits", () => {
	function policyApp(limits: { maxExpirySeconds: number; maxFilesPerNote: number }) {
		const hono = new Hono<AppEnv>();
		hono.onError((err, c) => {
			if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
			return c.json({ error: "Internal server error" }, 500);
		});
		hono.use("*", async (c, next) => {
			c.set("db", db);
			c.set("serverKey", TEST_SERVER_KEY);
			c.set("storage", new LocalStorage(TEST_FILES_PATH));
			c.set("chunkSize", 4_194_304);
			c.set("maxChunkedFileSize", 524_288_000);
			c.set("maxExpirySeconds", limits.maxExpirySeconds);
			c.set("maxFilesPerNote", limits.maxFilesPerNote);
			await next();
		});
		hono.use("/api/v1/notes/*", createWriteAuth([]));
		hono.route("/api/v1/notes", createNotesRoutes());
		return hono;
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

		const { notes: notesTable } = await import("../db/schema.js");
		const { eq } = await import("drizzle-orm");
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
});

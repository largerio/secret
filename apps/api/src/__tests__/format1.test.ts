import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
// Extends Zod with `.openapi()` before `@largerio/secret-shared` builds its
// schemas, as the routes expect (the production entry point does the same).
import "@hono/zod-openapi";
import {
	ARGON2_DEFAULT_ITERATIONS,
	ARGON2_DEFAULT_MEMORY_KIB,
	ENVELOPE_LENGTH,
	ENVELOPE_LENGTH_WITH_PASSWORD,
	encodeEnvelope,
	MAX_EXPIRY_SECONDS,
	MAX_FILES_PER_NOTE,
	MAX_INLINE_ENCRYPTED_SIZE,
	MAX_READS,
	MIN_EXPIRY_SECONDS,
} from "@largerio/secret-shared";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../app.js";
import { type AppDatabase, createDatabase } from "../db/index.js";
import { notes as notesTable, pendingDeletions, uploads as uploadsTable } from "../db/schema.js";
import { LocalStorage } from "../storage/local.js";
import { createTestApp } from "./testApp.js";

const TEST_DB_PATH = "./data/format1-test.db";
const TEST_FILES_PATH = "./data/format1-test-files";
const SERVER_KEY = randomBytes(32);
const API_KEY = randomBytes(32).toString("base64url");
const AUTH = { Authorization: `Bearer ${API_KEY}` };

const CIPHERTEXT = Buffer.from("format 1 ciphertext, opaque to the server");
const NONCE = new Uint8Array(24).fill(7);
const SALT = new Uint8Array(16).fill(9);

let db: AppDatabase;
let sqlite: DatabaseSync;
let app: Hono<AppEnv>;
const stops: Array<() => void> = [];

function createApp(env: Record<string, string> = {}): Hono<AppEnv> {
	const created = createTestApp({
		db,
		serverKey: SERVER_KEY,
		storage: new LocalStorage(TEST_FILES_PATH),
		env: { API_KEY, ...env },
	});
	stops.push(created.stop);
	return created.app;
}

function removeFiles(): void {
	for (const path of [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`]) {
		rmSync(path, { force: true });
	}
	rmSync(TEST_FILES_PATH, { recursive: true, force: true });
}

beforeEach(() => {
	removeFiles();
	mkdirSync(TEST_FILES_PATH, { recursive: true });
	({ db, sqlite } = createDatabase(TEST_DB_PATH));
	app = createApp();
});

afterEach(async () => {
	// A burned note's purge runs in the background: let it finish on this database.
	await vi.waitFor(() => expect(db.select().from(pendingDeletions).all()).toEqual([]));
	sqlite.close();
});

afterAll(() => {
	for (const stop of stops) stop();
	removeFiles();
});

interface Declared {
	readonly fileCount?: number;
	readonly maxReads?: number;
	readonly expiresIn?: number;
	readonly password?: boolean;
}

/** A format 1 envelope's bytes, as a writer encodes it. */
function envelopeOf(kind: "single-shot" | "chunked", declared: Declared = {}): Buffer {
	const settings = {
		fileCount: declared.fileCount ?? 0,
		maxReads: declared.maxReads ?? 1,
		expiresIn: declared.expiresIn ?? 3600,
		...(declared.password
			? {
					argon2: {
						salt: SALT,
						iterations: ARGON2_DEFAULT_ITERATIONS,
						memoryKiB: ARGON2_DEFAULT_MEMORY_KIB,
					},
				}
			: {}),
	};
	return Buffer.from(
		encodeEnvelope(
			kind === "single-shot"
				? { kind, nonce: NONCE, ...settings }
				: { kind, streamHeader: NONCE, ...settings },
		),
	);
}

/** An envelope's bytes with some of them overwritten, at their offsets. */
function tampered(envelope: Buffer, bytes: Record<number, number>): Buffer {
	const copy = Buffer.from(envelope);
	for (const [offset, value] of Object.entries(bytes)) {
		copy[Number(offset)] = value;
	}
	return copy;
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
const sha256 = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

function postNote(body: unknown, target: Hono<AppEnv> = app) {
	return target.request("/api/v1/notes", {
		method: "POST",
		headers: { ...AUTH, "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

function postMultipart(metadata: unknown, target: Hono<AppEnv> = app) {
	const form = new FormData();
	form.append("metadata", JSON.stringify(metadata));
	form.append("data", new Blob([CIPHERTEXT] as BlobPart[], { type: "application/octet-stream" }));
	return target.request("/api/v1/notes/upload", { method: "POST", headers: AUTH, body: form });
}

function postInit(body: unknown, target: Hono<AppEnv> = app) {
	return target.request("/api/v1/notes/upload/init", {
		method: "POST",
		headers: { ...AUTH, "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function createNote(envelope: Buffer, ciphertext: Buffer = CIPHERTEXT) {
	const res = await postNote({ envelope: b64(envelope), encryptedData: b64(ciphertext) });
	expect(res.status).toBe(201);
	return (await res.json()) as { id: string; expiresAt: string; deleteToken: string };
}

async function sendChunks(uploadId: string, chunks: readonly Buffer[]): Promise<void> {
	for (const [index, chunk] of chunks.entries()) {
		const res = await app.request(`/api/v1/notes/upload/${uploadId}/chunks/${String(index)}`, {
			method: "PUT",
			headers: { "Content-Type": "application/octet-stream", "X-Chunk-Hash": sha256(chunk) },
			body: new Uint8Array(chunk) as BodyInit,
		});
		expect(res.status).toBe(200);
	}
}

function complete(uploadId: string) {
	return app.request(`/api/v1/notes/upload/${uploadId}/complete`, {
		method: "POST",
		headers: AUTH,
	});
}

const CHUNKS = [Buffer.from("the head"), Buffer.from("a piece of a file")];

async function createChunkedNote(envelope: Buffer) {
	const init = await postInit({ envelope: b64(envelope), chunkCount: CHUNKS.length });
	expect(init.status).toBe(201);
	const { uploadId } = (await init.json()) as { uploadId: string };
	await sendChunks(uploadId, CHUNKS);
	const res = await complete(uploadId);
	expect(res.status).toBe(201);
	return (await res.json()) as { id: string; deleteToken: string };
}

function rowOf(id: string) {
	return db.select().from(notesTable).where(eq(notesTable.id, id)).get();
}

/** The chunks of a `/stream` body, its length-prefix framing undone. */
function unframe(body: Uint8Array): Buffer[] {
	const chunks: Buffer[] = [];
	const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
	let offset = 0;
	while (offset < body.byteLength) {
		const length = view.getUint32(offset);
		chunks.push(Buffer.from(body.subarray(offset + 4, offset + 4 + length)));
		offset += 4 + length;
	}
	return chunks;
}

describe("format 1 writes", () => {
	it("creates a note from its envelope alone, kept byte for byte", async () => {
		const envelope = envelopeOf("single-shot", { maxReads: 3, expiresIn: 600 });

		const { id, expiresAt } = await createNote(envelope);

		const row = rowOf(id);
		expect(row?.envelope).toEqual(envelope);
		expect(row).toMatchObject({
			clientNonce: "",
			salt: null,
			streamHeader: null,
			hasPassword: false,
			fileCount: 0,
			maxReads: 3,
			filePath: null,
		});
		expect((row?.expiresAt.getTime() ?? 0) - (row?.createdAt.getTime() ?? 0)).toBe(600_000);
		expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(590_000);
	});

	it("marks a note whose envelope carries Argon2id parameters as a password note", async () => {
		const envelope = envelopeOf("single-shot", { password: true });
		expect(envelope).toHaveLength(ENVELOPE_LENGTH_WITH_PASSWORD);

		const { id } = await createNote(envelope);

		expect(rowOf(id)).toMatchObject({ hasPassword: true, salt: null, envelope });
	});

	it("keeps a note with files in the storage", async () => {
		const { id } = await createNote(envelopeOf("single-shot", { fileCount: 2 }));

		expect(rowOf(id)).toMatchObject({ fileCount: 2, filePath: expect.any(String) });
	});

	it("creates a note from a multipart upload whose metadata is the envelope", async () => {
		for (const password of [false, true]) {
			const envelope = envelopeOf("single-shot", { fileCount: 1, password });

			const res = await postMultipart({ envelope: b64(envelope) });

			expect(res.status).toBe(201);
			const { id } = (await res.json()) as { id: string };
			expect(rowOf(id)).toMatchObject({
				envelope,
				hasPassword: password,
				fileCount: 1,
				clientNonce: "",
				filePath: expect.any(String),
			});
		}
	});

	it("opens an upload session that keeps only the envelope, then makes a chunked note of it", async () => {
		const envelope = envelopeOf("chunked", { fileCount: 1, password: true, maxReads: 0 });

		const init = await postInit({ envelope: b64(envelope), chunkCount: 2 });
		expect(init.status).toBe(201);
		const { uploadId } = (await init.json()) as { uploadId: string };
		const session = db.select().from(uploadsTable).where(eq(uploadsTable.id, uploadId)).get();
		expect(JSON.parse(session?.metadata ?? "")).toEqual({ envelope: b64(envelope) });

		await sendChunks(uploadId, CHUNKS);
		const res = await complete(uploadId);

		expect(res.status).toBe(201);
		const { id } = (await res.json()) as { id: string };
		expect(rowOf(id)).toMatchObject({
			envelope,
			chunkCount: 2,
			streamHeader: null,
			clientNonce: "",
			salt: null,
			hasPassword: true,
			fileCount: 1,
			maxReads: 0,
		});
	});
});

describe("format 1 reads", () => {
	it("serves the envelope as it came in X-Envelope, without format 0's headers", async () => {
		const envelope = envelopeOf("single-shot", { maxReads: 2 });
		const { id } = await createNote(envelope);

		const res = await app.request(`/api/v1/notes/${id}/raw?format=1`);

		expect(res.status).toBe(200);
		expect(Buffer.from(res.headers.get("X-Envelope") ?? "", "base64")).toEqual(envelope);
		expect(res.headers.get("X-Client-Nonce")).toBeNull();
		expect(res.headers.get("X-Salt")).toBeNull();
		expect(res.headers.get("X-Stream-Header")).toBeNull();
		expect(res.headers.get("X-Has-Password")).toBe("false");
		expect(res.headers.get("X-File-Count")).toBe("0");
		expect(res.headers.get("X-Created-At")).toMatch(/Z$/);
		expect(res.headers.get("X-Expires-At")).toMatch(/Z$/);
		expect(res.headers.get("Content-Length")).toBe(String(CIPHERTEXT.length));
		expect(Buffer.from(await res.arrayBuffer())).toEqual(CIPHERTEXT);
	});

	it("serves a password note's envelope, which holds its salt", async () => {
		const envelope = envelopeOf("single-shot", { fileCount: 1, password: true });
		const { id } = await createNote(envelope);

		const res = await app.request(`/api/v1/notes/${id}/raw?format=1`);

		expect(res.headers.get("X-Envelope")).toBe(b64(envelope));
		expect(res.headers.get("X-Has-Password")).toBe("true");
		expect(res.headers.get("X-File-Count")).toBe("1");
		expect(res.headers.get("X-Salt")).toBeNull();
		expect(Buffer.from(await res.arrayBuffer())).toEqual(CIPHERTEXT);
	});

	it("streams a chunked note with its envelope in place of the stream header", async () => {
		const envelope = envelopeOf("chunked", { fileCount: 1, password: true });
		const { id } = await createChunkedNote(envelope);

		const res = await app.request(`/api/v1/notes/${id}/stream?format=1`);

		expect(res.status).toBe(200);
		expect(Buffer.from(res.headers.get("X-Envelope") ?? "", "base64")).toEqual(envelope);
		expect(res.headers.get("X-Stream-Header")).toBeNull();
		expect(res.headers.get("X-Client-Nonce")).toBeNull();
		expect(res.headers.get("X-Salt")).toBeNull();
		expect(res.headers.get("X-Chunk-Count")).toBe("2");
		expect(res.headers.get("X-Has-Password")).toBe("true");
		expect(res.headers.get("X-File-Count")).toBe("1");
		expect(unframe(new Uint8Array(await res.arrayBuffer()))).toEqual(CHUNKS);
		// Burned by its one read.
		expect((await app.request(`/api/v1/notes/${id}/stream?format=1`)).status).toBe(404);
	});

	it("refuses a format 1 note on the JSON read without spending a read", async () => {
		const { id } = await createNote(envelopeOf("single-shot", { maxReads: 1 }));

		const res = await app.request(`/api/v1/notes/${id}`);

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({
			error: "Note is in another format than the one asked for",
		});
		expect(rowOf(id)?.readCount).toBe(0);

		// Still there, and still burned by its one read.
		expect((await app.request(`/api/v1/notes/${id}/raw?format=1`)).status).toBe(200);
		expect(rowOf(id)).toBeUndefined();
	});

	it("keeps the read count of a multi-read note the JSON read refuses", async () => {
		const { id } = await createNote(envelopeOf("single-shot", { maxReads: 2 }));

		expect((await app.request(`/api/v1/notes/${id}`)).status).toBe(400);
		expect((await app.request(`/api/v1/notes/${id}`)).status).toBe(400);

		expect(rowOf(id)?.readCount).toBe(0);
	});

	// What a client that knows only format 0 does (the SDK up to 1.2): it asks
	// for no format, and must be refused before any read is spent.
	it("refuses a format 1 note to a binary read that does not ask for format 1", async () => {
		const { id } = await createNote(envelopeOf("single-shot", { maxReads: 1 }));
		const { id: chunkedId } = await createChunkedNote(envelopeOf("chunked", { fileCount: 1 }));

		for (const path of [
			`/api/v1/notes/${id}/stream`,
			`/api/v1/notes/${id}/raw`,
			`/api/v1/notes/${id}/raw?format=0`,
			`/api/v1/notes/${chunkedId}/stream`,
			`/api/v1/notes/${chunkedId}/raw`,
		]) {
			expect((await app.request(path)).status, path).toBe(400);
		}
		expect(rowOf(id)?.readCount).toBe(0);
		expect(rowOf(chunkedId)?.readCount).toBe(0);
		const mismatch = await app.request(`/api/v1/notes/${chunkedId}/stream`);
		expect((await mismatch.json()).error).toBe("Note is in another format than the one asked for");
	});

	it("refuses a format 0 note to a read that asks for format 1", async () => {
		const res = await app.request("/api/v1/notes", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
			body: JSON.stringify({
				encryptedData: CIPHERTEXT.toString("base64"),
				clientNonce: "nonce",
				hasPassword: false,
				expiresIn: 3600,
				maxReads: 1,
				fileCount: 0,
			}),
		});
		const { id } = (await res.json()) as { id: string };

		expect((await app.request(`/api/v1/notes/${id}/raw?format=1`)).status).toBe(400);
		expect(rowOf(id)?.readCount).toBe(0);
		expect((await app.request(`/api/v1/notes/${id}/raw`)).status).toBe(200);
	});

	it("refuses a format other than 0 and 1", async () => {
		const { id } = await createNote(envelopeOf("single-shot", { maxReads: 1 }));
		expect((await app.request(`/api/v1/notes/${id}/raw?format=2`)).status).toBe(400);
		expect(rowOf(id)?.readCount).toBe(0);
	});

	it("sends a chunked format 1 note on the JSON read to its stream", async () => {
		const { id } = await createChunkedNote(envelopeOf("chunked", { fileCount: 1 }));

		const res = await app.request(`/api/v1/notes/${id}`);

		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe("Note is chunked: read it as a stream");
		expect(rowOf(id)?.readCount).toBe(0);
	});

	it("reports a format 1 note's state from its envelope", async () => {
		const { id } = await createNote(
			envelopeOf("single-shot", { fileCount: 3, maxReads: 5, password: true }),
		);
		const { id: chunkedId } = await createChunkedNote(envelopeOf("chunked", { fileCount: 1 }));

		const res = await app.request(`/api/v1/notes/${id}/exists`);

		expect(await res.json()).toEqual({
			exists: true,
			hasPassword: true,
			fileCount: 3,
			expiresAt: expect.any(String),
			maxReads: 5,
			readCount: 0,
			chunked: false,
		});
		expect(await (await app.request(`/api/v1/notes/${chunkedId}/exists`)).json()).toMatchObject({
			chunked: true,
			fileCount: 1,
		});
	});

	it("deletes a format 1 note with its token", async () => {
		const { id, deleteToken } = await createNote(envelopeOf("single-shot", { fileCount: 1 }));

		const res = await app.request(`/api/v1/notes/${id}`, {
			method: "DELETE",
			headers: { ...AUTH, "X-Delete-Token": deleteToken },
		});

		expect(res.status).toBe(200);
		expect(rowOf(id)).toBeUndefined();
	});
});

describe("format 0 reads, unchanged", () => {
	const nonce = Buffer.from("test-nonce-24-bytes!!!!").toString("base64");
	const salt = Buffer.from("test-salt-data-16bytes").toString("base64");
	const streamHeader = Buffer.from("test-header-24-bytes!!!").toString("base64");

	it("answers /raw with the nonce and the salt, and no envelope", async () => {
		const create = await postNote({
			encryptedData: b64(CIPHERTEXT),
			clientNonce: nonce,
			hasPassword: true,
			salt,
			expiresIn: 3600,
			maxReads: 0,
			fileCount: 0,
		});
		const { id } = (await create.json()) as { id: string };
		expect(rowOf(id)?.envelope).toBeNull();

		const res = await app.request(`/api/v1/notes/${id}/raw`);

		expect(res.headers.get("X-Client-Nonce")).toBe(nonce);
		expect(res.headers.get("X-Salt")).toBe(salt);
		expect(res.headers.get("X-Envelope")).toBeNull();
		expect(res.headers.get("X-Stream-Header")).toBeNull();
		expect(res.headers.get("Content-Length")).toBe(String(CIPHERTEXT.length));

		const json = await (await app.request(`/api/v1/notes/${id}`)).json();
		expect(Object.keys(json).sort()).toEqual([
			"clientNonce",
			"createdAt",
			"encryptedData",
			"expiresAt",
			"fileCount",
			"hasPassword",
			"salt",
		]);
		expect(json).toMatchObject({ clientNonce: nonce, salt, hasPassword: true });
	});

	it("answers /stream with the stream header and the salt, and no envelope", async () => {
		const init = await postInit({
			streamHeader,
			clientNonce: nonce,
			hasPassword: true,
			salt,
			expiresIn: 3600,
			maxReads: 1,
			fileCount: 1,
			chunkCount: 2,
		});
		const { uploadId } = (await init.json()) as { uploadId: string };
		const session = db.select().from(uploadsTable).where(eq(uploadsTable.id, uploadId)).get();
		expect(JSON.parse(session?.metadata ?? "")).toEqual({
			streamHeader,
			clientNonce: nonce,
			hasPassword: true,
			expiresIn: 3600,
			maxReads: 1,
			fileCount: 1,
			salt,
		});
		await sendChunks(uploadId, CHUNKS);
		const { id } = (await (await complete(uploadId)).json()) as { id: string };

		const res = await app.request(`/api/v1/notes/${id}/stream`);

		expect(res.headers.get("X-Stream-Header")).toBe(streamHeader);
		expect(res.headers.get("X-Salt")).toBe(salt);
		expect(res.headers.get("X-Chunk-Count")).toBe("2");
		expect(res.headers.get("X-Envelope")).toBeNull();
		expect(res.headers.get("X-Client-Nonce")).toBeNull();
		expect(unframe(new Uint8Array(await res.arrayBuffer()))).toEqual(CHUNKS);
	});
});

describe("format 1 refusals", () => {
	const single = envelopeOf("single-shot");
	const withPassword = envelopeOf("single-shot", { password: true });

	// Every way an envelope is refused before a note is made of it.
	const malformed: ReadonlyArray<readonly [string, string]> = [
		["is not base64", "not base64!"],
		["is empty", ""],
		["is longer than any envelope", b64(Buffer.alloc(ENVELOPE_LENGTH_WITH_PASSWORD + 3))],
		["is not format 1", b64(tampered(single, { 0: 2 }))],
		["has an unknown kind", b64(tampered(single, { 1: 2 }))],
		["has an unknown derivation", b64(tampered(single, { 2: 2 }))],
		["is cut short", b64(single.subarray(0, ENVELOPE_LENGTH - 1))],
		["declares a password it does not carry", b64(tampered(single, { 2: 1 }))],
		["carries a password it does not declare", b64(tampered(withPassword, { 2: 0 }))],
		["asks too few Argon2id iterations", b64(tampered(withPassword, { 53: 0 }))],
		["asks too many Argon2id iterations", b64(tampered(withPassword, { 53: 11 }))],
		["asks too little Argon2id memory", b64(tampered(withPassword, { 55: 0 }))],
		["asks too much Argon2id memory", b64(tampered(withPassword, { 54: 0xff }))],
		["is a chunked note's", b64(envelopeOf("chunked"))],
		[
			"declares too many files",
			b64(envelopeOf("single-shot", { fileCount: MAX_FILES_PER_NOTE + 1 })),
		],
		["declares too many reads", b64(envelopeOf("single-shot", { maxReads: MAX_READS + 1 }))],
		["expires too soon", b64(envelopeOf("single-shot", { expiresIn: MIN_EXPIRY_SECONDS - 1 }))],
		["expires too late", b64(envelopeOf("single-shot", { expiresIn: MAX_EXPIRY_SECONDS + 1 }))],
	];

	it.each(malformed)("refuses an envelope that %s", async (_, envelope) => {
		const res = await postNote({ envelope, encryptedData: b64(CIPHERTEXT) });

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "Invalid request" });
		expect(db.select().from(notesTable).all()).toHaveLength(0);
	});

	it("accepts the protocol's bounds", async () => {
		for (const declared of [
			{ fileCount: MAX_FILES_PER_NOTE, maxReads: MAX_READS, expiresIn: MAX_EXPIRY_SECONDS },
			{ fileCount: 0, maxReads: 0, expiresIn: MIN_EXPIRY_SECONDS },
		]) {
			const res = await postNote({
				envelope: b64(envelopeOf("single-shot", declared)),
				encryptedData: b64(CIPHERTEXT),
			});
			expect(res.status).toBe(201);
		}
	});

	it("refuses an envelope without a ciphertext", async () => {
		expect((await postNote({ envelope: b64(single) })).status).toBe(400);
	});

	// Format 0's schema ignores an `envelope` key: an envelope refused must not
	// let the same request through as a format 0 note, behind a format 1 link.
	it("refuses an envelope it refuses, whatever format 0 fields come with it", async () => {
		const format0 = { clientNonce: "nonce", hasPassword: false, expiresIn: 3600, maxReads: 1 };
		const tooManyReads = { 4: 0xff, 5: 0xff }; // maxReads 65535
		const chunked = envelopeOf("chunked");

		for (const envelope of ["!!!", b64(chunked), b64(tampered(single, tooManyReads))]) {
			const ciphertext = CIPHERTEXT.toString("base64");
			const json = await postNote({
				...format0,
				envelope,
				encryptedData: ciphertext,
				fileCount: 0,
			});
			expect(json.status).toBe(400);
			const multipart = await postMultipart({ ...format0, envelope, fileCount: 1 });
			expect(multipart.status).toBe(400);
		}
		for (const envelope of ["!!!", b64(single), b64(tampered(chunked, tooManyReads))]) {
			const init = await postInit({
				...format0,
				envelope,
				streamHeader: "header",
				fileCount: 0,
				chunkCount: 1,
			});
			expect(init.status).toBe(400);
		}
		expect(db.select().from(notesTable).all()).toHaveLength(0);
		expect(db.select().from(uploadsTable).all()).toHaveLength(0);
	});

	it("refuses a multipart envelope of no file, of a chunked note, or malformed", async () => {
		for (const envelope of [
			envelopeOf("single-shot", { fileCount: 0 }),
			envelopeOf("chunked", { fileCount: 1 }),
			tampered(envelopeOf("single-shot", { fileCount: 1 }), { 0: 0 }),
		]) {
			const res = await postMultipart({ envelope: b64(envelope) });
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error: "Invalid request" });
		}
		expect(db.select().from(notesTable).all()).toHaveLength(0);
	});

	it("refuses an upload session for a single-shot envelope, a malformed one, or no chunk count", async () => {
		for (const body of [
			{ envelope: b64(single), chunkCount: 2 },
			{ envelope: b64(tampered(envelopeOf("chunked"), { 1: 7 })), chunkCount: 2 },
			{ envelope: b64(envelopeOf("chunked")) },
		]) {
			const res = await postInit(body);
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error: "Invalid request" });
		}
		expect(db.select().from(uploadsTable).all()).toHaveLength(0);
	});

	it("refuses to complete a session whose envelope no longer holds", async () => {
		for (const envelope of ["not base64!", b64(single)]) {
			const init = await postInit({ envelope: b64(envelopeOf("chunked")), chunkCount: 1 });
			const { uploadId } = (await init.json()) as { uploadId: string };
			await sendChunks(uploadId, [Buffer.from("head")]);
			db.update(uploadsTable)
				.set({ metadata: JSON.stringify({ envelope }) })
				.where(eq(uploadsTable.id, uploadId))
				.run();

			const res = await complete(uploadId);

			expect(res.status).toBe(500);
			expect((await res.json()).error).toBe("Corrupted upload session");
		}
		expect(db.select().from(notesTable).all()).toHaveLength(0);
	});
});

describe("the instance's limits, for format 1", () => {
	it("holds the envelope's expiry and files to the operator's ceilings on every write", async () => {
		const tight = createApp({ MAX_EXPIRY: "3600", MAX_FILES_PER_NOTE: "3" });
		const tooLong = { expiresIn: 7200, fileCount: 1 };
		const tooMany = { expiresIn: 3600, fileCount: 4 };
		const expiry = { error: "Maximum expiry is 3600 seconds" };
		const files = { error: "Maximum 3 files per note" };

		for (const [declared, error] of [
			[tooLong, expiry],
			[tooMany, files],
		] as const) {
			const json = await postNote(
				{ envelope: b64(envelopeOf("single-shot", declared)), encryptedData: b64(CIPHERTEXT) },
				tight,
			);
			const multipart = await postMultipart(
				{ envelope: b64(envelopeOf("single-shot", declared)) },
				tight,
			);
			const init = await postInit(
				{ envelope: b64(envelopeOf("chunked", declared)), chunkCount: 1 },
				tight,
			);
			for (const res of [json, multipart, init]) {
				expect(res.status).toBe(400);
				expect(await res.json()).toEqual(error);
			}
		}

		const atCeiling = await postNote(
			{
				envelope: b64(envelopeOf("single-shot", { expiresIn: 3600, fileCount: 3 })),
				encryptedData: b64(CIPHERTEXT),
			},
			tight,
		);
		expect(atCeiling.status).toBe(201);
	});

	it("keeps a note without files to the inline ceiling", async () => {
		const res = await postNote({
			envelope: b64(envelopeOf("single-shot")),
			encryptedData: b64(Buffer.alloc(MAX_INLINE_ENCRYPTED_SIZE + 1)),
		});

		expect(res.status).toBe(413);
	});

	it("refuses a note past the storage quota", async () => {
		const full = createApp({ STORAGE_QUOTA_BYTES: "16" });

		const res = await postNote(
			{ envelope: b64(envelopeOf("single-shot")), encryptedData: b64(CIPHERTEXT) },
			full,
		);

		expect(res.status).toBe(507);
	});

	it("refuses more chunks than the instance takes", async () => {
		const small = createApp({ CHUNK_SIZE: "16", MAX_CHUNKED_FILE_SIZE: "32" });

		const res = await postInit(
			{ envelope: b64(envelopeOf("chunked", { fileCount: 1 })), chunkCount: 3 },
			small,
		);

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "Maximum 2 chunks allowed" });
	});
});

describe("the OpenAPI document, for format 1", () => {
	interface Schema {
		readonly anyOf?: readonly Schema[];
		readonly properties?: Record<string, Schema>;
		readonly required?: readonly string[];
		readonly type?: string;
		readonly contentEncoding?: string;
		readonly format?: string;
		readonly description?: string;
		readonly minLength?: number;
		readonly maxLength?: number;
		readonly not?: unknown;
	}

	async function requestSchema(path: string): Promise<Schema> {
		const doc = (await (await app.request("/api/v1/openapi.json")).json()) as {
			paths: Record<
				string,
				{ post: { requestBody: { content: { "application/json": { schema: Schema } } } } }
			>;
		};
		return doc.paths[path]?.post.requestBody.content["application/json"].schema ?? {};
	}

	it.each([
		["/notes", "encryptedData"],
		["/notes/upload/init", "chunkCount"],
	])("documents %s in either format, the envelope as a base64 string", async (path, field) => {
		const schema = await requestSchema(path);

		const [format1, format0] = schema.anyOf ?? [];
		expect(format1?.required).toEqual(["envelope", field]);
		// 34 bytes, or 58 with a password, in base64.
		expect(format1?.properties?.["envelope"]).toMatchObject({
			type: "string",
			minLength: 48,
			maxLength: 80,
		});
		expect(format1?.properties?.["envelope"]?.description).toContain("envelope");
		expect(format0?.required).toContain("clientNonce");
		// Format 0 documents the envelope as a key no value matches.
		expect(format0?.properties?.["envelope"]).toMatchObject({ not: {} });
	});
});

import { createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
// Extends Zod with `.openapi()` before `@largerio/secret-shared` builds its
// schemas, as the routes expect (the production entry point does the same).
import "@hono/zod-openapi";
import { deriveFormat1Keys, initSodium, verifierOf } from "@largerio/secret-crypto";
import {
	ARGON2_DEFAULT_ITERATIONS,
	ARGON2_DEFAULT_MEMORY_KIB,
	ARGON2_MIN_ITERATIONS,
	ARGON2_MIN_MEMORY_KIB,
	ENVELOPE_LENGTH,
	ENVELOPE_LENGTH_WITH_PASSWORD,
	encodeEnvelope,
	MAX_EXPIRY_SECONDS,
	MAX_FILES_PER_NOTE,
	MAX_INLINE_ENCRYPTED_SIZE,
	MAX_PASSWORD_ATTEMPTS,
	MAX_READS,
	MIN_EXPIRY_SECONDS,
} from "@largerio/secret-shared";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../app.js";
import { type AppDatabase, createDatabase } from "../db/index.js";
import { notes as notesTable, pendingDeletions, uploads as uploadsTable } from "../db/schema.js";
import { drainPendingDeletions } from "../pendingDeletions.js";
import type { StorageBackend } from "../storage/index.js";
import { LocalStorage } from "../storage/local.js";
import { overrideStorage } from "./storageDoubles.js";
import { createTestApp } from "./testApp.js";

const TEST_DB_PATH = "./data/format1-test.db";
const TEST_FILES_PATH = "./data/format1-test-files";
const SERVER_KEY = randomBytes(32);
const API_KEY = randomBytes(32).toString("base64url");
const AUTH = { Authorization: `Bearer ${API_KEY}` };

const CIPHERTEXT = Buffer.from("format 1 ciphertext, opaque to the server");
const NONCE = new Uint8Array(24).fill(7);
const SALT = new Uint8Array(16).fill(9);

// A reader's proofs. Random: the server only ever sees them, and the verifiers
// a writer sends for them, as bytes. Real ones are derived further down.
const LINK_PROOF = randomBytes(32);
const PASSWORD_PROOF = randomBytes(32);
const sha256Of = (data: Uint8Array): Buffer => createHash("sha256").update(data).digest();

let db: AppDatabase;
let sqlite: DatabaseSync;
let app: Hono<AppEnv>;
const stops: Array<() => void> = [];

function createApp(
	env: Record<string, string> = {},
	storage: StorageBackend = new LocalStorage(TEST_FILES_PATH),
): Hono<AppEnv> {
	const created = createTestApp({ db, serverKey: SERVER_KEY, storage, env: { API_KEY, ...env } });
	stops.push(created.stop);
	return created.app;
}

function removeFiles(): void {
	for (const path of [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`]) {
		rmSync(path, { force: true });
	}
	rmSync(TEST_FILES_PATH, { recursive: true, force: true });
}

beforeAll(async () => {
	await initSodium();
});

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

const LINK_VERIFIER = b64(sha256Of(LINK_PROOF));
const PASSWORD_VERIFIER = b64(sha256Of(PASSWORD_PROOF));

/** The verifiers a writer sends beside an envelope: the password's for a password note only. */
function verifiersFor(envelope: Buffer) {
	return {
		linkVerifier: LINK_VERIFIER,
		...(envelope.length === ENVELOPE_LENGTH_WITH_PASSWORD
			? { passwordVerifier: PASSWORD_VERIFIER }
			: {}),
	};
}

/** What a reader of the notes above sends. */
const PROOFS = { linkProof: b64(LINK_PROOF), passwordProof: b64(PASSWORD_PROOF) };
const WRONG_LINK = { linkProof: b64(PASSWORD_PROOF), passwordProof: b64(PASSWORD_PROOF) };
const WRONG_PASSWORD = { linkProof: b64(LINK_PROOF), passwordProof: b64(LINK_PROOF) };

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

/** A format 1 read: no write authentication, the proofs in the body. */
function postReads(id: string, proofs: unknown = PROOFS, target: Hono<AppEnv> = app) {
	return target.request(`/api/v1/notes/${id}/reads`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(proofs),
	});
}

async function createNote(envelope: Buffer, ciphertext: Buffer = CIPHERTEXT) {
	const res = await postNote({
		envelope: b64(envelope),
		...verifiersFor(envelope),
		encryptedData: b64(ciphertext),
	});
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
	return app.request(`/api/v1/notes/upload/${uploadId}/complete`, { method: "POST" });
}

const CHUNKS = [Buffer.from("the head"), Buffer.from("a piece of a file")];

async function createChunkedNote(envelope: Buffer) {
	const init = await postInit({
		envelope: b64(envelope),
		...verifiersFor(envelope),
		chunkCount: CHUNKS.length,
	});
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

/** The purges queued, and how long the cleanup job is held off each, from now. */
function queuedPurges() {
	return db
		.select()
		.from(pendingDeletions)
		.all()
		.map((row) => ({ noteId: row.noteId, heldMs: row.nextRetryAt.getTime() - Date.now() }));
}

/** Runs the queued purges, as the cleanup job does once they are due. */
function drainQueuedPurges(storage: StorageBackend = new LocalStorage(TEST_FILES_PATH)) {
	db.update(pendingDeletions)
		.set({ nextRetryAt: new Date(0) })
		.run();
	return drainPendingDeletions(db, storage);
}

/** What the storage still holds, of any note. */
function storedObjects() {
	return Array.fromAsync(new LocalStorage(TEST_FILES_PATH).list());
}

async function existsOf(id: string) {
	return (await (await app.request(`/api/v1/notes/${id}/exists`)).json()) as Record<
		string,
		unknown
	>;
}

/** The chunks of a length-prefixed body, its framing undone. */
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

/** What the server keeps of a verifier: PROTOCOL.md's "Server layer", computed apart. */
function sealedAs(
	role: "link" | "password",
	noteId: string,
	envelope: Buffer,
	verifier: string,
): Buffer {
	const key = Buffer.from(
		hkdfSync("sha256", SERVER_KEY, new Uint8Array(32), "secret/server verifier", 32),
	);
	return createHmac("sha256", key)
		.update(
			Buffer.concat([
				Buffer.from(role, "ascii"),
				Buffer.from([0]),
				Buffer.from(noteId, "ascii"),
				sha256Of(envelope),
				Buffer.from(verifier, "base64"),
			]),
		)
		.digest();
}

describe("format 1 writes", () => {
	it("creates a note from its envelope, kept byte for byte, and its sealed link verifier", async () => {
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
			passwordVerifier: null,
			failedAttempts: 0,
		});
		expect(row?.linkVerifier).toEqual(sealedAs("link", id, envelope, LINK_VERIFIER));
		expect((row?.expiresAt.getTime() ?? 0) - (row?.createdAt.getTime() ?? 0)).toBe(600_000);
		expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(590_000);
	});

	it("marks a note whose envelope carries Argon2id parameters as a password note", async () => {
		const envelope = envelopeOf("single-shot", { password: true });
		expect(envelope).toHaveLength(ENVELOPE_LENGTH_WITH_PASSWORD);

		const { id } = await createNote(envelope);

		expect(rowOf(id)).toMatchObject({ hasPassword: true, salt: null, envelope });
		expect(rowOf(id)?.passwordVerifier).toEqual(
			sealedAs("password", id, envelope, PASSWORD_VERIFIER),
		);
	});

	// A copy of the database, without the instance key, gives nothing to test a
	// proof or a password against, and a verifier moved to another note fails.
	it("never stores a verifier as it came, and seals each with its note's id", async () => {
		const envelope = envelopeOf("single-shot", { password: true });

		const first = rowOf((await createNote(envelope)).id);
		const second = rowOf((await createNote(envelope)).id);

		for (const row of [first, second]) {
			expect(row?.linkVerifier?.equals(Buffer.from(LINK_VERIFIER, "base64"))).toBe(false);
			expect(row?.passwordVerifier?.equals(Buffer.from(PASSWORD_VERIFIER, "base64"))).toBe(false);
			expect(row?.linkVerifier).toHaveLength(32);
		}
		expect(first?.linkVerifier?.equals(second?.linkVerifier ?? Buffer.alloc(0))).toBe(false);
		expect(first?.passwordVerifier?.equals(second?.passwordVerifier ?? Buffer.alloc(0))).toBe(
			false,
		);
	});

	it("keeps a note with files in the storage", async () => {
		const { id } = await createNote(envelopeOf("single-shot", { fileCount: 2 }));

		expect(rowOf(id)).toMatchObject({ fileCount: 2, filePath: expect.any(String) });
	});

	it("creates a note from a multipart upload whose metadata is the envelope and its verifiers", async () => {
		for (const password of [false, true]) {
			const envelope = envelopeOf("single-shot", { fileCount: 1, password });

			const res = await postMultipart({ envelope: b64(envelope), ...verifiersFor(envelope) });

			expect(res.status).toBe(201);
			const { id } = (await res.json()) as { id: string };
			expect(rowOf(id)).toMatchObject({
				envelope,
				hasPassword: password,
				fileCount: 1,
				clientNonce: "",
				filePath: expect.any(String),
				linkVerifier: sealedAs("link", id, envelope, LINK_VERIFIER),
				passwordVerifier: password ? sealedAs("password", id, envelope, PASSWORD_VERIFIER) : null,
			});
		}
	});

	it("keeps the envelope and the sealed verifiers in the upload session, then in its note", async () => {
		const envelope = envelopeOf("chunked", { fileCount: 1, password: true, maxReads: 0 });

		const init = await postInit({
			envelope: b64(envelope),
			...verifiersFor(envelope),
			chunkCount: 2,
		});
		expect(init.status).toBe(201);
		const { uploadId } = (await init.json()) as { uploadId: string };
		const session = db.select().from(uploadsTable).where(eq(uploadsTable.id, uploadId)).get();
		const noteId = session?.noteId ?? "";
		expect(JSON.parse(session?.metadata ?? "")).toEqual({
			envelope: b64(envelope),
			linkVerifier: b64(sealedAs("link", noteId, envelope, LINK_VERIFIER)),
			passwordVerifier: b64(sealedAs("password", noteId, envelope, PASSWORD_VERIFIER)),
		});

		await sendChunks(uploadId, CHUNKS);
		const res = await complete(uploadId);

		expect(res.status).toBe(201);
		const { id } = (await res.json()) as { id: string };
		expect(id).toBe(noteId);
		expect(rowOf(id)).toMatchObject({
			envelope,
			chunkCount: 2,
			streamHeader: null,
			clientNonce: "",
			salt: null,
			hasPassword: true,
			fileCount: 1,
			maxReads: 0,
			linkVerifier: sealedAs("link", id, envelope, LINK_VERIFIER),
			passwordVerifier: sealedAs("password", id, envelope, PASSWORD_VERIFIER),
			failedAttempts: 0,
		});
	});
});

describe("format 1 write refusals: the verifiers", () => {
	const plain = envelopeOf("single-shot", { fileCount: 1 });
	const withPassword = envelopeOf("single-shot", { fileCount: 1, password: true });
	const tooShort = b64(randomBytes(31));
	const tooLong = b64(randomBytes(33));

	// Every way a write's verifiers are refused: missing, or of the wrong shape,
	// or not matching what the envelope declares.
	const refused: ReadonlyArray<readonly [string, Buffer, Record<string, unknown>]> = [
		["has no link verifier", plain, {}],
		[
			"has no link verifier, but a password one",
			withPassword,
			{ passwordVerifier: PASSWORD_VERIFIER },
		],
		["has a link verifier too short", plain, { linkVerifier: tooShort }],
		["has a link verifier too long", plain, { linkVerifier: tooLong }],
		["has a link verifier that is not base64", plain, { linkVerifier: "!".repeat(44) }],
		[
			"has a link verifier in base64url",
			plain,
			{ linkVerifier: sha256Of(LINK_PROOF).toString("base64url") },
		],
		[
			"is a password note's without a password verifier",
			withPassword,
			{ linkVerifier: LINK_VERIFIER },
		],
		[
			"is a password note's with a password verifier too short",
			withPassword,
			{ linkVerifier: LINK_VERIFIER, passwordVerifier: tooShort },
		],
		[
			"has a password verifier without a password",
			plain,
			{ linkVerifier: LINK_VERIFIER, passwordVerifier: PASSWORD_VERIFIER },
		],
	];

	it.each(refused)("refuses a write that %s", async (_, envelope, verifiers) => {
		const chunked = tampered(envelope, { 1: 1 });

		const json = await postNote({
			envelope: b64(envelope),
			...verifiers,
			encryptedData: b64(CIPHERTEXT),
		});
		const multipart = await postMultipart({ envelope: b64(envelope), ...verifiers });
		const init = await postInit({ envelope: b64(chunked), ...verifiers, chunkCount: 1 });

		for (const res of [json, multipart, init]) {
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error: "Invalid request" });
		}
		expect(db.select().from(notesTable).all()).toHaveLength(0);
		expect(db.select().from(uploadsTable).all()).toHaveLength(0);
	});
});

describe("/exists, for format 1", () => {
	it("serves a format 1 note's envelope, and a password note's attempts left", async () => {
		const withPassword = envelopeOf("single-shot", { fileCount: 3, maxReads: 5, password: true });
		const chunked = envelopeOf("chunked", { fileCount: 1 });
		const { id } = await createNote(withPassword);
		const { id: chunkedId } = await createChunkedNote(chunked);

		expect(await existsOf(id)).toEqual({
			exists: true,
			hasPassword: true,
			fileCount: 3,
			expiresAt: expect.any(String),
			maxReads: 5,
			readCount: 0,
			chunked: false,
			envelope: b64(withPassword),
			passwordAttemptsLeft: MAX_PASSWORD_ATTEMPTS,
		});
		expect(await existsOf(chunkedId)).toEqual({
			exists: true,
			hasPassword: false,
			fileCount: 1,
			expiresAt: expect.any(String),
			maxReads: 1,
			readCount: 0,
			chunked: true,
			envelope: b64(chunked),
		});
	});

	it("serves neither to a format 0 note", async () => {
		const res = await postNote({
			encryptedData: b64(CIPHERTEXT),
			clientNonce: "nonce",
			hasPassword: true,
			salt: "salt",
			expiresIn: 3600,
			fileCount: 0,
		});
		const { id } = (await res.json()) as { id: string };

		const info = await existsOf(id);
		expect(info).toMatchObject({ exists: true, hasPassword: true });
		expect(info).not.toHaveProperty("envelope");
		expect(info).not.toHaveProperty("passwordAttemptsLeft");
	});
});

describe("format 1 reads, with proofs", () => {
	it("serves a note from the database once its link proof checks out, then burns it", async () => {
		const { id } = await createNote(envelopeOf("single-shot", { maxReads: 1 }));

		const res = await postReads(id, { linkProof: b64(LINK_PROOF) });

		expect(res.status).toBe(200);
		expect(Buffer.from(await res.arrayBuffer())).toEqual(CIPHERTEXT);
		expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
		expect(res.headers.get("Content-Length")).toBe(String(CIPHERTEXT.length));
		expect(res.headers.get("Cache-Control")).toBe("no-store");
		expect(res.headers.get("X-Has-Password")).toBe("false");
		expect(res.headers.get("X-File-Count")).toBe("0");
		expect(res.headers.get("X-Created-At")).toMatch(/Z$/);
		expect(res.headers.get("X-Expires-At")).toMatch(/Z$/);
		// The reader has the envelope from /exists: nothing else to open it with.
		for (const header of [
			"X-Envelope",
			"X-Client-Nonce",
			"X-Salt",
			"X-Stream-Header",
			"X-Chunk-Count",
		]) {
			expect(res.headers.get(header), header).toBeNull();
		}

		expect(rowOf(id)).toBeUndefined();
		expect((await postReads(id)).status).toBe(404);
	});

	it("serves a password note from the storage once both proofs check out", async () => {
		const { id } = await createNote(
			envelopeOf("single-shot", { fileCount: 1, password: true, maxReads: 2 }),
		);

		const res = await postReads(id);

		expect(res.status).toBe(200);
		expect(res.headers.get("X-Has-Password")).toBe("true");
		expect(res.headers.get("X-File-Count")).toBe("1");
		expect(res.headers.get("X-Salt")).toBeNull();
		expect(Buffer.from(await res.arrayBuffer())).toEqual(CIPHERTEXT);
		expect(rowOf(id)).toMatchObject({ readCount: 1, failedAttempts: 0 });
		expect(await existsOf(id)).toMatchObject({
			readCount: 1,
			passwordAttemptsLeft: MAX_PASSWORD_ATTEMPTS,
		});
	});

	it("streams a chunked note as /stream does, without its stream header, then burns it", async () => {
		const { id } = await createChunkedNote(envelopeOf("chunked", { fileCount: 1, password: true }));

		const res = await postReads(id);

		expect(res.status).toBe(200);
		expect(res.headers.get("X-Chunk-Count")).toBe("2");
		expect(res.headers.get("X-Has-Password")).toBe("true");
		expect(res.headers.get("X-File-Count")).toBe("1");
		for (const header of ["X-Envelope", "X-Stream-Header", "X-Client-Nonce", "X-Salt"]) {
			expect(res.headers.get(header), header).toBeNull();
		}
		expect(unframe(new Uint8Array(await res.arrayBuffer()))).toEqual(CHUNKS);
		expect((await postReads(id)).status).toBe(404);
	});

	it("needs no write authentication", async () => {
		const { id } = await createNote(envelopeOf("single-shot"));

		const res = await app.request(`/api/v1/notes/${id}/reads`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer not-a-key" },
			body: JSON.stringify(PROOFS),
		});

		expect(res.status).toBe(200);
	});

	it("checks the proofs the crypto package derives from the link and the password", async () => {
		const linkKey = randomBytes(32);
		const argon2 = {
			salt: SALT,
			iterations: ARGON2_MIN_ITERATIONS,
			memoryKiB: ARGON2_MIN_MEMORY_KIB,
		};
		const envelope = Buffer.from(
			encodeEnvelope({
				kind: "single-shot",
				nonce: NONCE,
				fileCount: 0,
				maxReads: 0,
				expiresIn: 3600,
				argon2,
			}),
		);
		const writer = deriveFormat1Keys(linkKey, { password: "Pässwörd".normalize("NFC"), argon2 });
		const { passwordProof = new Uint8Array() } = writer;
		const created = await postNote({
			envelope: b64(envelope),
			linkVerifier: b64(verifierOf(writer.linkProof)),
			passwordVerifier: b64(verifierOf(passwordProof)),
			encryptedData: b64(CIPHERTEXT),
		});
		const { id } = (await created.json()) as { id: string };

		// The same password in another Unicode form gives the same proofs.
		const reader = deriveFormat1Keys(linkKey, { password: "Pässwörd".normalize("NFD"), argon2 });
		const wrong = deriveFormat1Keys(linkKey, { password: "wrong", argon2 });
		const otherLink = deriveFormat1Keys(randomBytes(32), { password: "Pässwörd", argon2 });
		const proofs = (keys: typeof reader) => ({
			linkProof: b64(keys.linkProof),
			passwordProof: b64(keys.passwordProof ?? new Uint8Array()),
		});

		expect((await postReads(id, proofs(otherLink))).status).toBe(403);
		expect((await postReads(id, proofs(wrong))).status).toBe(403);
		const res = await postReads(id, proofs(reader));
		expect(res.status).toBe(200);
		expect(Buffer.from(await res.arrayBuffer())).toEqual(CIPHERTEXT);

		// Without a password, the link proof alone.
		const plainKey = randomBytes(32);
		const plain = await postNote({
			envelope: b64(envelopeOf("single-shot")),
			linkVerifier: b64(verifierOf(deriveFormat1Keys(plainKey).linkProof)),
			encryptedData: b64(CIPHERTEXT),
		});
		const { id: plainId } = (await plain.json()) as { id: string };
		const plainProof = { linkProof: b64(deriveFormat1Keys(plainKey).linkProof) };
		expect((await postReads(plainId, plainProof)).status).toBe(200);
	});

	it("ignores a password proof sent for a note without a password", async () => {
		const { id } = await createNote(envelopeOf("single-shot", { maxReads: 0 }));

		expect((await postReads(id, WRONG_PASSWORD)).status).toBe(200);
		expect((await postReads(id, { linkProof: b64(LINK_PROOF) })).status).toBe(200);
		expect(rowOf(id)?.failedAttempts).toBe(0);
	});

	it("refuses a format 0 note without spending its read", async () => {
		const res = await postNote({
			encryptedData: b64(CIPHERTEXT),
			clientNonce: "nonce",
			hasPassword: false,
			expiresIn: 3600,
			maxReads: 1,
			fileCount: 0,
		});
		const { id } = (await res.json()) as { id: string };

		const read = await postReads(id);

		expect(read.status).toBe(400);
		expect(await read.json()).toEqual({
			error: "Note is in another format than the one asked for",
		});
		expect(rowOf(id)?.readCount).toBe(0);
		expect((await app.request(`/api/v1/notes/${id}/raw`)).status).toBe(200);
	});

	it("refuses an expired note as one that never existed, and deletes it", async () => {
		const { id } = await createNote(envelopeOf("single-shot", { fileCount: 1 }));
		db.update(notesTable)
			.set({ expiresAt: new Date(Date.now() - 1000) })
			.where(eq(notesTable.id, id))
			.run();

		const res = await postReads(id);

		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "Note not found" });
		expect(rowOf(id)).toBeUndefined();
	});

	it("refuses a request without its proofs, or with malformed ones", async () => {
		const { id } = await createNote(envelopeOf("single-shot", { password: true }));

		for (const body of [
			{},
			{ passwordProof: b64(PASSWORD_PROOF) },
			{ linkProof: b64(randomBytes(31)), passwordProof: b64(PASSWORD_PROOF) },
			{ linkProof: b64(LINK_PROOF), passwordProof: "not base64!" },
			{ linkProof: LINK_PROOF.toString("hex") },
		]) {
			const res = await postReads(id, body);
			expect(res.status, JSON.stringify(body)).toBe(400);
			expect(await res.json()).toEqual({ error: "Invalid request" });
		}
		const bare = await app.request(`/api/v1/notes/${id}/reads`, { method: "POST" });
		expect(bare.status).toBe(400);
		expect((await postReads("not-an-id")).status).toBe(400);
		expect(rowOf(id)).toMatchObject({ readCount: 0, failedAttempts: 0 });
	});
});

describe("format 1 read refusals: the proofs", () => {
	it("refuses a wrong link proof and counts nothing, whatever the password proof", async () => {
		const { id } = await createNote(envelopeOf("single-shot", { password: true }));
		const { id: plainId } = await createNote(envelopeOf("single-shot"));

		for (const note of [id, plainId]) {
			for (let attempt = 0; attempt <= MAX_PASSWORD_ATTEMPTS; attempt += 1) {
				const res = await postReads(note, WRONG_LINK);
				expect(res.status).toBe(403);
				expect(await res.json()).toEqual({ error: "Invalid link proof" });
			}
			expect(rowOf(note)).toMatchObject({ readCount: 0, failedAttempts: 0 });
		}
		expect(await existsOf(id)).toMatchObject({ passwordAttemptsLeft: MAX_PASSWORD_ATTEMPTS });
		expect((await postReads(id)).status).toBe(200);
	});

	// The link proof is checked first: a request that has neither proof right
	// learns nothing of what else the note asks.
	it("refuses a wrong link proof sent without a password proof as a wrong link proof", async () => {
		const { id } = await createNote(envelopeOf("single-shot", { password: true }));

		const res = await postReads(id, { linkProof: b64(PASSWORD_PROOF) });

		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: "Invalid link proof" });
		expect(rowOf(id)).toMatchObject({ readCount: 0, failedAttempts: 0 });
	});

	it("asks a password note's read for its password proof, and counts nothing", async () => {
		const { id } = await createNote(envelopeOf("single-shot", { password: true }));

		const res = await postReads(id, { linkProof: b64(LINK_PROOF) });

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "Password proof required" });
		expect(rowOf(id)).toMatchObject({ readCount: 0, failedAttempts: 0 });
	});

	it("counts a wrong password, spends no read, and still serves the right one", async () => {
		const { id } = await createNote(envelopeOf("single-shot", { password: true, maxReads: 1 }));

		const res = await postReads(id, WRONG_PASSWORD);

		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: "Wrong password" });
		expect(rowOf(id)).toMatchObject({ readCount: 0, failedAttempts: 1 });
		expect(await existsOf(id)).toMatchObject({ passwordAttemptsLeft: MAX_PASSWORD_ATTEMPTS - 1 });

		expect((await postReads(id)).status).toBe(200);
		expect(rowOf(id)).toBeUndefined();
	});

	it("keeps counting across reads that succeed: the count is the note's, for its life", async () => {
		const { id } = await createNote(envelopeOf("single-shot", { password: true, maxReads: 3 }));

		expect((await postReads(id, WRONG_PASSWORD)).status).toBe(403);
		expect((await postReads(id, WRONG_PASSWORD)).status).toBe(403);
		expect((await postReads(id)).status).toBe(200);

		expect(rowOf(id)).toMatchObject({ readCount: 1, failedAttempts: 2 });
		expect(await existsOf(id)).toMatchObject({
			readCount: 1,
			passwordAttemptsLeft: MAX_PASSWORD_ATTEMPTS - 2,
		});
	});

	/** Sends every wrong password a note takes, the last deleting it. */
	async function exhaust(id: string, target: Hono<AppEnv> = app): Promise<void> {
		for (let attempt = 1; attempt <= MAX_PASSWORD_ATTEMPTS; attempt += 1) {
			const res = await postReads(id, WRONG_PASSWORD, target);
			expect(res.status).toBe(403);
			expect(await res.json()).toEqual({ error: "Wrong password" });
			if (attempt < MAX_PASSWORD_ATTEMPTS) {
				expect(await existsOf(id)).toMatchObject({
					passwordAttemptsLeft: MAX_PASSWORD_ATTEMPTS - attempt,
				});
			}
		}

		expect(rowOf(id)).toBeUndefined();
		expect(await existsOf(id)).toEqual({ exists: false });
		expect((await postReads(id)).status).toBe(404);
	}

	it.each([
		["in the database", 0],
		["in the storage", 1],
	])(
		"deletes a single-shot note %s on its last wrong password, and purges it",
		async (_, fileCount) => {
			const { id } = await createNote(
				envelopeOf("single-shot", { fileCount, password: true, maxReads: 0 }),
			);

			await exhaust(id);

			await vi.waitFor(() => expect(db.select().from(pendingDeletions).all()).toEqual([]));
			expect(await storedObjects()).toEqual([]);
		},
	);

	// A reader served before may still be streaming its chunks: they stay for
	// the window a burned stream gets.
	it("deletes a chunked note on its last wrong password, and holds its purge a day", async () => {
		const storage = new LocalStorage(TEST_FILES_PATH);
		const purge = vi.fn((noteId: string) => storage.purge(noteId));
		const watched = createApp({}, overrideStorage(storage, { purge }));
		const { id } = await createChunkedNote(
			envelopeOf("chunked", { fileCount: 1, password: true, maxReads: 0 }),
		);

		await exhaust(id, watched);

		expect(purge).not.toHaveBeenCalled();
		const [queued, ...others] = queuedPurges();
		expect(others).toEqual([]);
		expect(queued?.noteId).toBe(id);
		expect(queued?.heldMs).toBeGreaterThan(23 * 60 * 60_000);
		expect(await storedObjects()).not.toEqual([]);

		expect(await drainQueuedPurges()).toMatchObject({ drained: 1, failed: 0 });
		expect(await storedObjects()).toEqual([]);
	});

	it("counts wrong passwords sent at once, and deletes the note once", async () => {
		const { id } = await createNote(envelopeOf("single-shot", { password: true, maxReads: 0 }));

		const answers = await Promise.all(
			Array.from({ length: MAX_PASSWORD_ATTEMPTS + 1 }, () => postReads(id, WRONG_PASSWORD)),
		);

		// Each counted once: the one past the last finds the note gone.
		expect(answers.map((res) => res.status).sort()).toEqual([
			...Array.from({ length: MAX_PASSWORD_ATTEMPTS }, () => 403),
			404,
		]);
		expect(rowOf(id)).toBeUndefined();
	});

	// A row the server cannot check proofs against: never served, whatever the
	// proofs, and nothing spent nor counted on it.
	it.each([
		["has no link verifier", { password: false }, { linkVerifier: null }],
		[
			"is a password note's without its password verifier",
			{ password: true },
			{ passwordVerifier: null },
		],
		[
			"has a password verifier without a password",
			{ password: false },
			{ passwordVerifier: Buffer.alloc(32, 1) },
		],
		["has a link verifier too short", { password: true }, { linkVerifier: Buffer.alloc(31, 1) }],
		["has a link verifier too long", { password: true }, { linkVerifier: Buffer.alloc(33, 1) }],
		[
			"has a password verifier too short",
			{ password: true },
			{ passwordVerifier: Buffer.alloc(31, 1) },
		],
		["has an empty password verifier", { password: true }, { passwordVerifier: Buffer.alloc(0) }],
	] as const)(
		"refuses a format 1 row that %s, before anything is spent",
		async (_, declared, corrupt) => {
			const { id } = await createNote(envelopeOf("single-shot", declared));
			db.update(notesTable).set(corrupt).where(eq(notesTable.id, id)).run();

			for (const proofs of [PROOFS, WRONG_PASSWORD]) {
				const res = await postReads(id, proofs);

				expect(res.status).toBe(500);
				expect((await res.json()).error).toBe("Failed to decrypt note");
			}
			expect(rowOf(id)).toMatchObject({ readCount: 0, failedAttempts: 0 });
		},
	);

	// A format 1 row that lost its envelope but kept a verifier is never taken
	// for a format 0 note: the GET reads would serve it, and burn it, to whoever
	// knows its id, with an empty nonce.
	it.each([
		["both its verifiers", {}],
		["its link verifier alone", { passwordVerifier: null }],
		["its password verifier alone", { linkVerifier: null }],
	] as const)(
		"refuses a row that lost its envelope but kept %s, on every read, spending nothing",
		async (_, kept) => {
			const { id } = await createNote(envelopeOf("single-shot", { password: true, maxReads: 1 }));
			const { id: chunkedId } = await createChunkedNote(
				envelopeOf("chunked", { fileCount: 1, password: true }),
			);

			for (const note of [id, chunkedId]) {
				db.update(notesTable)
					.set({ envelope: null, ...kept })
					.where(eq(notesTable.id, note))
					.run();

				for (const path of ["", "/raw", "/stream"]) {
					const res = await app.request(`/api/v1/notes/${note}${path}`);
					expect(res.status, path).toBe(400);
					expect((await res.json()).error, path).toBe(
						"Note is in another format than the one asked for",
					);
				}
				const res = await postReads(note);
				expect(res.status).toBe(500);
				expect((await res.json()).error).toBe("Failed to decrypt note");

				expect(rowOf(note)).toMatchObject({ readCount: 0, failedAttempts: 0 });
				// It has no envelope to give a format 1 reader, who refuses it then.
				expect(await existsOf(note)).toMatchObject({ exists: true });
				expect(await existsOf(note)).not.toHaveProperty("envelope");
			}
		},
	);
});

describe("password attempts, taken before the proof is compared", () => {
	// The database refusing writes (a full disk): the attempt cannot be taken,
	// so the proof is never compared. A right password and a wrong one get the
	// same answer, after the same work, nothing loaded: no guess goes uncounted,
	// and none stands out by its time.
	it("answers a right and a wrong password alike when their attempt cannot be counted", async () => {
		const storage = new LocalStorage(TEST_FILES_PATH);
		const read = vi.fn((key: string) => storage.read(key));
		const watched = createApp({}, overrideStorage(storage, { read }));
		const { id } = await createNote(
			envelopeOf("single-shot", { fileCount: 1, password: true, maxReads: 0 }),
		);
		sqlite.exec(`CREATE TRIGGER disk_full BEFORE UPDATE OF failed_attempts ON notes
			BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END`);

		const right = await postReads(id, PROOFS, watched);
		const wrong = await postReads(id, WRONG_PASSWORD, watched);

		for (const res of [right, wrong]) {
			expect(res.status).toBe(500);
			expect(await res.json()).toEqual({
				error: "Internal server error",
				errorId: expect.any(String),
			});
		}
		expect(read).not.toHaveBeenCalled();
		expect(rowOf(id)).toMatchObject({ readCount: 0, failedAttempts: 0 });

		sqlite.exec("DROP TRIGGER disk_full");
		const res = await postReads(id, PROOFS, watched);
		expect(res.status).toBe(200);
		expect(Buffer.from(await res.arrayBuffer())).toEqual(CIPHERTEXT);
		expect(read).toHaveBeenCalledOnce();
	});

	it("gives a right password back the attempt it took, even the last one left", async () => {
		const { id } = await createNote(envelopeOf("single-shot", { password: true, maxReads: 0 }));
		for (let attempt = 1; attempt < MAX_PASSWORD_ATTEMPTS; attempt += 1) {
			expect((await postReads(id, WRONG_PASSWORD)).status).toBe(403);
		}

		for (let read = 1; read <= 2; read += 1) {
			expect((await postReads(id)).status).toBe(200);
			expect(rowOf(id)).toMatchObject({
				readCount: read,
				failedAttempts: MAX_PASSWORD_ATTEMPTS - 1,
			});
			expect(await existsOf(id)).toMatchObject({ passwordAttemptsLeft: 1 });
		}
	});

	// Only a crash between taking an attempt and settling it leaves a note
	// without an attempt left: its last one was taken, never settled.
	it.each([
		["at the limit", MAX_PASSWORD_ATTEMPTS],
		["past it", MAX_PASSWORD_ATTEMPTS + 1],
	])("deletes a note a crash left %s, refused as gone", async (_, failedAttempts) => {
		const { id } = await createNote(
			envelopeOf("single-shot", { fileCount: 1, password: true, maxReads: 0 }),
		);
		db.update(notesTable).set({ failedAttempts }).where(eq(notesTable.id, id)).run();

		// Gone already, to a reader. A wrong link proof takes no attempt, and
		// leaves it as it is.
		expect(await existsOf(id)).toEqual({ exists: false });
		expect((await postReads(id, WRONG_LINK)).status).toBe(403);
		expect(rowOf(id)).toMatchObject({ failedAttempts });

		const res = await postReads(id);

		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "Note not found" });
		expect(rowOf(id)).toBeUndefined();
		await vi.waitFor(() => expect(db.select().from(pendingDeletions).all()).toEqual([]));
		expect(await storedObjects()).toEqual([]);
	});
});

describe("the last wrong password, while a right reader awaits the storage", () => {
	/** Where a storage call stops, once reached, until it is released. */
	function holdPoint() {
		const reached = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		return {
			reached: reached.promise,
			release: () => released.resolve(),
			async stop(): Promise<void> {
				reached.resolve();
				await released.promise;
			},
		};
	}

	async function takeAllButOne(id: string, target: Hono<AppEnv>): Promise<void> {
		for (let attempt = 1; attempt < MAX_PASSWORD_ATTEMPTS; attempt += 1) {
			expect((await postReads(id, WRONG_PASSWORD, target)).status).toBe(403);
		}
	}

	// Its proofs checked out and its attempt is back, but its read is not spent
	// yet: the note goes before it is, and the reader is refused, as one that
	// lost a race to a burn.
	it("refuses a reader still loading a file note the last wrong password deleted", async () => {
		const storage = new LocalStorage(TEST_FILES_PATH);
		const hold = holdPoint();
		const racing = createApp(
			{},
			overrideStorage(storage, {
				read: async (key) => {
					await hold.stop();
					return storage.read(key);
				},
			}),
		);
		const { id } = await createNote(
			envelopeOf("single-shot", { fileCount: 1, password: true, maxReads: 0 }),
		);
		await takeAllButOne(id, racing);

		const reader = postReads(id, PROOFS, racing);
		await hold.reached;
		expect(rowOf(id)).toMatchObject({ readCount: 0, failedAttempts: MAX_PASSWORD_ATTEMPTS - 1 });

		const last = await postReads(id, WRONG_PASSWORD, racing);
		expect(last.status).toBe(403);
		expect(rowOf(id)).toBeUndefined();
		// Purged at once, as a single-shot note is.
		await vi.waitFor(() => expect(db.select().from(pendingDeletions).all()).toEqual([]));
		expect(await storedObjects()).toEqual([]);

		hold.release();
		const res = await reader;
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "Note not found" });
	});

	// Its read spent, a reader of a chunked note that takes several reads is
	// streaming it when the last wrong password deletes it: its chunks stay
	// until the window is past, and its stream ends whole.
	it("lets a reader finish streaming a chunked note the last wrong password deleted", async () => {
		const storage = new LocalStorage(TEST_FILES_PATH);
		const hold = holdPoint();
		const purge = vi.fn((noteId: string) => storage.purge(noteId));
		const racing = createApp(
			{},
			overrideStorage(storage, {
				readChunk: async (noteId, index) => {
					if (index > 0) {
						await hold.stop();
					}
					return storage.readChunk(noteId, index);
				},
				purge,
			}),
		);
		const { id } = await createChunkedNote(
			envelopeOf("chunked", { fileCount: 1, password: true, maxReads: 3 }),
		);
		await takeAllButOne(id, racing);

		const res = await postReads(id, PROOFS, racing);
		expect(res.status).toBe(200);
		const body = res.arrayBuffer();
		await hold.reached;
		expect(rowOf(id)).toMatchObject({ readCount: 1, failedAttempts: MAX_PASSWORD_ATTEMPTS - 1 });

		const last = await postReads(id, WRONG_PASSWORD, racing);
		expect(last.status).toBe(403);
		expect(rowOf(id)).toBeUndefined();
		expect(await existsOf(id)).toEqual({ exists: false });
		const [queued, ...others] = queuedPurges();
		expect(others).toEqual([]);
		expect(queued?.noteId).toBe(id);
		expect(queued?.heldMs).toBeGreaterThan(23 * 60 * 60_000);

		hold.release();
		expect(unframe(new Uint8Array(await body))).toEqual(CHUNKS);
		expect(purge).not.toHaveBeenCalled();

		// The cleanup job purges the chunks once the window is past.
		expect(queuedPurges()).toHaveLength(1);
		expect(await drainQueuedPurges()).toMatchObject({ drained: 1, failed: 0 });
		expect(await storedObjects()).toEqual([]);
	});
});

describe("the sealed verifiers, against a write to the database", () => {
	// Whoever can write to the database, but lacks the instance key, holds the
	// link but not the password.
	it("refuses a note whose link verifier was copied over its password verifier", async () => {
		const { id } = await createNote(envelopeOf("single-shot", { password: true }));
		sqlite.prepare("UPDATE notes SET password_verifier = link_verifier WHERE id = ?").run(id);

		for (const proofs of [WRONG_PASSWORD, PROOFS]) {
			const res = await postReads(id, proofs);

			expect(res.status).toBe(403);
			expect(await res.json()).toEqual({ error: "Wrong password" });
		}
		expect(rowOf(id)).toMatchObject({ readCount: 0 });
	});

	it("refuses a note whose envelope was rewritten without a password, its verifier dropped", async () => {
		const { id } = await createNote(envelopeOf("single-shot", { password: true }));
		db.update(notesTable)
			.set({ envelope: envelopeOf("single-shot"), hasPassword: false, passwordVerifier: null })
			.where(eq(notesTable.id, id))
			.run();

		for (const proofs of [{ linkProof: b64(LINK_PROOF) }, PROOFS]) {
			const res = await postReads(id, proofs);

			expect(res.status).toBe(403);
			expect(await res.json()).toEqual({ error: "Invalid link proof" });
		}
		expect(rowOf(id)).toMatchObject({ readCount: 0, failedAttempts: 0 });
	});

	it("seals the same verifier apart as the link's and as the password's", async () => {
		const envelope = envelopeOf("single-shot", { password: true });
		const res = await postNote({
			envelope: b64(envelope),
			linkVerifier: LINK_VERIFIER,
			passwordVerifier: LINK_VERIFIER,
			encryptedData: b64(CIPHERTEXT),
		});
		const { id } = (await res.json()) as { id: string };

		const row = rowOf(id);
		expect(row?.linkVerifier).toEqual(sealedAs("link", id, envelope, LINK_VERIFIER));
		expect(row?.passwordVerifier).toEqual(sealedAs("password", id, envelope, LINK_VERIFIER));
		expect(row?.linkVerifier?.equals(row.passwordVerifier ?? Buffer.alloc(0))).toBe(false);
	});
});

describe("format 0 reads of a format 1 note", () => {
	it("refuses a format 1 note on the JSON read without spending a read", async () => {
		const { id } = await createNote(envelopeOf("single-shot", { maxReads: 1 }));

		const res = await app.request(`/api/v1/notes/${id}`);

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({
			error: "Note is in another format than the one asked for",
		});
		expect(rowOf(id)?.readCount).toBe(0);

		// Still there, and still burned by its one read.
		expect((await postReads(id)).status).toBe(200);
		expect(rowOf(id)).toBeUndefined();
	});

	it("keeps the read count of a multi-read note the JSON read refuses", async () => {
		const { id } = await createNote(envelopeOf("single-shot", { maxReads: 2 }));

		expect((await app.request(`/api/v1/notes/${id}`)).status).toBe(400);
		expect((await app.request(`/api/v1/notes/${id}`)).status).toBe(400);

		expect(rowOf(id)?.readCount).toBe(0);
	});

	// What a client that knows only format 0 does (the SDK up to 1.2): every
	// read of its own must be refused before any read is spent, whatever the
	// note's kind, and so is a draft client asking for format 1 by query.
	it("refuses a format 1 note on every format 0 read, whatever its kind", async () => {
		const { id } = await createNote(envelopeOf("single-shot", { maxReads: 1 }));
		const { id: chunkedId } = await createChunkedNote(envelopeOf("chunked", { fileCount: 1 }));

		for (const note of [id, chunkedId]) {
			for (const path of ["", "/raw", "/raw?format=1", "/stream", "/stream?format=1"]) {
				const res = await app.request(`/api/v1/notes/${note}${path}`);
				expect(res.status, path).toBe(400);
				expect((await res.json()).error, path).toBe(
					"Note is in another format than the one asked for",
				);
			}
			expect(rowOf(note)?.readCount).toBe(0);
		}
	});

	it("refuses a corrupt format 1 row there as format 1, not as corrupt", async () => {
		const { id } = await createNote(envelopeOf("single-shot"));
		db.update(notesTable).set({ linkVerifier: null }).where(eq(notesTable.id, id)).run();

		expect((await app.request(`/api/v1/notes/${id}/raw`)).status).toBe(400);
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
		expect(rowOf(id)).toMatchObject({ envelope: null, linkVerifier: null, passwordVerifier: null });

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

	// With either set of verifiers, so that the envelope, and not a verifier
	// that does not match it, is what the write is refused for.
	const verifierSets = [
		{ linkVerifier: LINK_VERIFIER },
		{ linkVerifier: LINK_VERIFIER, passwordVerifier: PASSWORD_VERIFIER },
	];

	it.each(malformed)("refuses an envelope that %s", async (_, envelope) => {
		for (const verifiers of verifierSets) {
			const res = await postNote({ envelope, ...verifiers, encryptedData: b64(CIPHERTEXT) });

			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error: "Invalid request" });
		}
		expect(db.select().from(notesTable).all()).toHaveLength(0);
	});

	it("accepts the protocol's bounds", async () => {
		for (const declared of [
			{ fileCount: MAX_FILES_PER_NOTE, maxReads: MAX_READS, expiresIn: MAX_EXPIRY_SECONDS },
			{ fileCount: 0, maxReads: 0, expiresIn: MIN_EXPIRY_SECONDS },
		]) {
			const envelope = envelopeOf("single-shot", declared);
			const res = await postNote({
				envelope: b64(envelope),
				...verifiersFor(envelope),
				encryptedData: b64(CIPHERTEXT),
			});
			expect(res.status).toBe(201);
		}
	});

	it("refuses an envelope without a ciphertext", async () => {
		expect((await postNote({ envelope: b64(single), ...verifiersFor(single) })).status).toBe(400);
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
				linkVerifier: LINK_VERIFIER,
				encryptedData: ciphertext,
				fileCount: 0,
			});
			expect(json.status).toBe(400);
			const multipart = await postMultipart({
				...format0,
				envelope,
				linkVerifier: LINK_VERIFIER,
				fileCount: 1,
			});
			expect(multipart.status).toBe(400);
		}
		for (const envelope of ["!!!", b64(single), b64(tampered(chunked, tooManyReads))]) {
			const init = await postInit({
				...format0,
				envelope,
				linkVerifier: LINK_VERIFIER,
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
			const res = await postMultipart({ envelope: b64(envelope), ...verifiersFor(envelope) });
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error: "Invalid request" });
		}
		expect(db.select().from(notesTable).all()).toHaveLength(0);
	});

	it("refuses an upload session for a single-shot envelope, a malformed one, or no chunk count", async () => {
		const chunked = envelopeOf("chunked");
		for (const body of [
			{ envelope: b64(single), ...verifiersFor(single), chunkCount: 2 },
			{ envelope: b64(tampered(chunked, { 1: 7 })), ...verifiersFor(chunked), chunkCount: 2 },
			{ envelope: b64(chunked), ...verifiersFor(chunked) },
		]) {
			const res = await postInit(body);
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error: "Invalid request" });
		}
		expect(db.select().from(uploadsTable).all()).toHaveLength(0);
	});

	it("refuses to complete a session whose envelope or verifiers no longer hold", async () => {
		const chunked = envelopeOf("chunked");
		const withPasswordChunked = envelopeOf("chunked", { password: true });
		for (const metadata of [
			{ envelope: "not base64!", linkVerifier: LINK_VERIFIER },
			{ envelope: b64(single), linkVerifier: LINK_VERIFIER },
			{ envelope: b64(chunked) },
			{ envelope: b64(chunked), linkVerifier: "short" },
			{ envelope: b64(withPasswordChunked), linkVerifier: LINK_VERIFIER },
			{ envelope: b64(chunked), linkVerifier: LINK_VERIFIER, passwordVerifier: PASSWORD_VERIFIER },
		]) {
			const init = await postInit({
				envelope: b64(chunked),
				...verifiersFor(chunked),
				chunkCount: 1,
			});
			const { uploadId } = (await init.json()) as { uploadId: string };
			await sendChunks(uploadId, [Buffer.from("head")]);
			db.update(uploadsTable)
				.set({ metadata: JSON.stringify(metadata) })
				.where(eq(uploadsTable.id, uploadId))
				.run();

			const res = await complete(uploadId);

			expect(res.status, JSON.stringify(metadata)).toBe(500);
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
			const single = envelopeOf("single-shot", declared);
			const chunked = envelopeOf("chunked", declared);
			const json = await postNote(
				{ envelope: b64(single), ...verifiersFor(single), encryptedData: b64(CIPHERTEXT) },
				tight,
			);
			const multipart = await postMultipart(
				{ envelope: b64(single), ...verifiersFor(single) },
				tight,
			);
			const init = await postInit(
				{ envelope: b64(chunked), ...verifiersFor(chunked), chunkCount: 1 },
				tight,
			);
			for (const res of [json, multipart, init]) {
				expect(res.status).toBe(400);
				expect(await res.json()).toEqual(error);
			}
		}

		const atCeiling = envelopeOf("single-shot", { expiresIn: 3600, fileCount: 3 });
		const res = await postNote(
			{ envelope: b64(atCeiling), ...verifiersFor(atCeiling), encryptedData: b64(CIPHERTEXT) },
			tight,
		);
		expect(res.status).toBe(201);
	});

	it("keeps a note without files to the inline ceiling", async () => {
		const envelope = envelopeOf("single-shot");
		const res = await postNote({
			envelope: b64(envelope),
			...verifiersFor(envelope),
			encryptedData: b64(Buffer.alloc(MAX_INLINE_ENCRYPTED_SIZE + 1)),
		});

		expect(res.status).toBe(413);
	});

	it("refuses a note past the storage quota", async () => {
		const full = createApp({ STORAGE_QUOTA_BYTES: "16" });
		const envelope = envelopeOf("single-shot");

		const res = await postNote(
			{ envelope: b64(envelope), ...verifiersFor(envelope), encryptedData: b64(CIPHERTEXT) },
			full,
		);

		expect(res.status).toBe(507);
	});

	it("refuses more chunks than the instance takes", async () => {
		const small = createApp({ CHUNK_SIZE: "16", MAX_CHUNKED_FILE_SIZE: "32" });
		const envelope = envelopeOf("chunked", { fileCount: 1 });

		const res = await postInit(
			{ envelope: b64(envelope), ...verifiersFor(envelope), chunkCount: 3 },
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
		readonly pattern?: string;
		readonly not?: unknown;
	}

	interface Operation {
		readonly parameters?: ReadonlyArray<{ readonly name: string; readonly in: string }>;
		readonly requestBody?: {
			readonly required?: boolean;
			readonly content: { readonly "application/json": { readonly schema: Schema } };
		};
	}

	async function operations(): Promise<Record<string, Record<string, Operation>>> {
		const doc = (await (await app.request("/api/v1/openapi.json")).json()) as {
			paths: Record<string, Record<string, Operation>>;
		};
		return doc.paths;
	}

	async function requestSchema(path: string): Promise<Schema> {
		const paths = await operations();
		return paths[path]?.["post"]?.requestBody?.content["application/json"].schema ?? {};
	}

	it.each([
		["/notes", "encryptedData"],
		["/notes/upload/init", "chunkCount"],
	])("documents %s in either format, the envelope as a base64 string", async (path, field) => {
		const schema = await requestSchema(path);

		const [format1, format0] = schema.anyOf ?? [];
		expect(format1?.required).toEqual(["envelope", "linkVerifier", field]);
		// 34 bytes, or 58 with a password, in base64.
		expect(format1?.properties?.["envelope"]).toMatchObject({
			type: "string",
			minLength: 48,
			maxLength: 80,
		});
		expect(format1?.properties?.["envelope"]?.description).toContain("envelope");
		for (const verifier of ["linkVerifier", "passwordVerifier"]) {
			expect(format1?.properties?.[verifier]).toMatchObject({ type: "string" });
			expect(format1?.properties?.[verifier]?.description).toContain("Never served");
		}
		expect(format0?.required).toContain("clientNonce");
		// Format 0 documents the envelope as a key no value matches.
		expect(format0?.properties?.["envelope"]).toMatchObject({ not: {} });
	});

	it("documents the format 1 read, its proofs in a required JSON body", async () => {
		const paths = await operations();
		const read = paths["/notes/{id}/reads"]?.["post"];

		expect(read?.requestBody?.required).toBe(true);
		const schema = read?.requestBody?.content["application/json"].schema;
		expect(schema?.required).toEqual(["linkProof"]);
		expect(Object.keys(schema?.properties ?? {})).toEqual(["linkProof", "passwordProof"]);
	});

	it("documents no format query on the format 0 reads", async () => {
		const paths = await operations();

		for (const path of ["/notes/{id}/raw", "/notes/{id}/stream"]) {
			const names = (paths[path]?.["get"]?.parameters ?? []).map((parameter) => parameter.name);
			expect(names, path).toEqual(["id"]);
		}
	});
});

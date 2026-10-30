import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { type ServerType, serve } from "@hono/node-server";
// Extends Zod with `.openapi()` before `@largerio/secret-shared` builds its
// schemas, which the SDK imports too (the production entry point does the same).
import "@hono/zod-openapi";
import { SecretApiError, SecretClient, SecretDecryptionError } from "@largerio/secret-sdk";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type AppDatabase, createDatabase } from "../db/index.js";
import { pendingDeletions } from "../db/schema.js";
import { LocalStorage } from "../storage/local.js";
import { createTestApp } from "./testApp.js";

// The SDK and the API each have their own tests, against a mocked other side.
// Here the real client talks to the real application over HTTP, as it does
// once deployed, so a mismatch between them (an endpoint, a header, a limit, a
// chunk size, an encoding, what compression does to a response) fails a test.
// Writes authenticate with an API key, as an SDK user does; the Cap widget is
// a browser concern.
vi.mock("../routes/cap.js", () => ({
	cap: { validateToken: vi.fn(() => Promise.resolve({ success: false })) },
	createCapRoutes: () => new Hono(),
}));

const TEST_DB_PATH = "./data/sdk-test.db";
const TEST_FILES_PATH = "./data/sdk-test-files";
const SERVER_KEY = randomBytes(32);
const API_KEY = randomBytes(32).toString("base64url");
// Far below the 4 MiB default, so a chunked note needs only a few hundred KiB.
const CHUNK_SIZE = 64 * 1024;
// Argon2id at libsodium's moderate setting (256 MiB) runs in several test
// files at once.
const ARGON2_TIMEOUT = 30_000;

let sqlite: ReturnType<typeof createDatabase>["sqlite"];
let db: AppDatabase;
let server: ServerType;
let baseUrl: string;
let stopApp: () => void;

/** The requests the clients made, as `METHOD /path`: ids as `:id`, numbers as `:n`. */
let calls: string[] = [];

const PATH_WORDS = new Set([
	"api",
	"v1",
	"notes",
	"upload",
	"init",
	"chunks",
	"reads",
	"complete",
	"raw",
	"stream",
	"exists",
]);

function route(method: string, url: string): string {
	const parts = new URL(url).pathname.split("/").map((part) => {
		if (part === "" || PATH_WORDS.has(part)) return part;
		return /^\d+$/.test(part) ? ":n" : ":id";
	});
	return `${method} ${parts.join("/")}`;
}

function removeFiles(): void {
	for (const path of [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`]) {
		rmSync(path, { force: true });
	}
	rmSync(TEST_FILES_PATH, { recursive: true, force: true });
}

// One instance for the file, as a server runs: each test works on notes of its
// own.
beforeAll(async () => {
	removeFiles();
	mkdirSync(TEST_FILES_PATH, { recursive: true });
	({ db, sqlite } = createDatabase(TEST_DB_PATH));
	const { app, stop } = createTestApp({
		db,
		serverKey: SERVER_KEY,
		storage: new LocalStorage(TEST_FILES_PATH),
		env: { API_KEY, CHUNK_SIZE: String(CHUNK_SIZE) },
	});
	stopApp = stop;
	const port = await new Promise<number>((resolve) => {
		server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info: AddressInfo) =>
			resolve(info.port),
		);
	});
	baseUrl = `http://127.0.0.1:${String(port)}`;
});

beforeEach(() => {
	calls = [];
});

afterAll(async () => {
	// A chunked note read for the last time is purged once its stream ends,
	// after the response: let the last purges finish before the database
	// closes under them.
	await vi.waitFor(() => expect(db.select().from(pendingDeletions).all()).toEqual([]));
	await new Promise((resolve) => server.close(resolve));
	stopApp();
	sqlite.close();
	removeFiles();
});

/** A client of the server above, whose every request is recorded in `calls`. */
function connect(apiKey: string | null = API_KEY): Promise<SecretClient> {
	return SecretClient.create({
		baseUrl,
		...(apiKey ? { apiKey } : {}),
		fetch: (input, init) => {
			const request = input instanceof Request ? input : null;
			calls.push(route(init?.method ?? request?.method ?? "GET", request?.url ?? String(input)));
			return fetch(input, init);
		},
	});
}

function bytes(size: number): Uint8Array {
	return new Uint8Array(randomBytes(size));
}

describe("format 0, through the SDK and the application", () => {
	it("round-trips a text note, then finds it burned", async () => {
		const client = await connect();
		const { id, keyFragment } = await client.createNote({
			format: 0,
			text: "hello, server",
			maxReads: 1,
		});

		const info = await client.checkNote(id);
		expect(info).toMatchObject({ exists: true, hasPassword: false, chunked: false, fileCount: 0 });

		const { payload } = await client.readNote(id, keyFragment);
		expect(payload.text).toBe("hello, server");

		await expect(client.readNote(id, keyFragment)).rejects.toMatchObject({ status: 404 });
		expect(await client.checkNote(id)).toMatchObject({ exists: false });

		// Unhinted, the client tries the stream first: refused (400) for an
		// inline note, at no cost to its single read.
		expect(calls).toEqual([
			"POST /api/v1/notes",
			"GET /api/v1/notes/:id/exists",
			"GET /api/v1/notes/:id/stream",
			"GET /api/v1/notes/:id/raw",
			"GET /api/v1/notes/:id/stream",
			"GET /api/v1/notes/:id/exists",
		]);
	});

	it("round-trips files through the multipart upload", async () => {
		const client = await connect();
		const data = bytes(20 * 1024);
		const { id, keyFragment } = await client.createNote({
			format: 0,
			text: "two attachments",
			files: [
				{ name: "a.bin", type: "application/octet-stream", data },
				{ name: "empty.txt", type: "text/plain", data: new Uint8Array() },
			],
			chunkSize: CHUNK_SIZE,
		});

		const info = await client.checkNote(id);
		expect(info).toMatchObject({ exists: true, chunked: false, fileCount: 2 });

		// Over HTTP the binary read keeps its Content-Length, which the progress needs.
		const downloaded: number[] = [];
		const { payload } = await client.readNote(id, keyFragment, {
			chunked: false,
			onDownloadProgress: (progress) => downloaded.push(progress),
		});
		expect(downloaded.at(-1)).toBe(1);
		expect(payload.text).toBe("two attachments");
		expect(payload.files?.map((file) => file.name)).toEqual(["a.bin", "empty.txt"]);
		expect(payload.files?.[0]?.data).toEqual(data);
		expect(payload.files?.[1]?.data).toEqual(new Uint8Array());

		expect(calls).toEqual([
			"POST /api/v1/notes/upload",
			"GET /api/v1/notes/:id/exists",
			"GET /api/v1/notes/:id/raw",
		]);
	});

	it("round-trips a chunked note at the instance's chunk size", async () => {
		const client = await connect();
		const data = bytes(5 * CHUNK_SIZE + 123);
		const progress: number[] = [];
		const { id, keyFragment } = await client.createNote({
			format: 0,
			files: [{ name: "big.bin", type: "application/octet-stream", data }],
			chunkSize: CHUNK_SIZE,
			maxReads: 2,
			onProgress: (info) => progress.push(info.overallProgress),
		});
		expect(progress.at(-1)).toBe(1);
		// The metadata chunk, then six of file data.
		expect(calls).toEqual([
			"POST /api/v1/notes/upload/init",
			...Array.from({ length: 7 }, () => "PUT /api/v1/notes/upload/:id/chunks/:n"),
			"POST /api/v1/notes/upload/:id/complete",
		]);

		const info = await client.checkNote(id);
		expect(info).toMatchObject({ exists: true, chunked: true, fileCount: 1, readCount: 0 });

		const first = await client.readNote(id, keyFragment, { chunked: true });
		expect(first.payload.files?.[0]?.data).toEqual(data);

		// Without the hint, the client finds the stream on its own.
		const second = await client.readNote(id, keyFragment);
		expect(second.payload.files?.[0]?.data).toEqual(data);

		await expect(client.readNote(id, keyFragment)).rejects.toMatchObject({ status: 404 });
		expect(calls.slice(-4)).toEqual([
			"GET /api/v1/notes/:id/exists",
			"GET /api/v1/notes/:id/stream",
			"GET /api/v1/notes/:id/stream",
			"GET /api/v1/notes/:id/stream",
		]);
	});

	it("refuses chunks larger than the instance's chunk size", async () => {
		const client = await connect();
		const data = bytes(3 * CHUNK_SIZE);

		// The SDK's 4 MiB default would send the whole file in one chunk.
		const attempt = client.createNote({
			format: 0,
			files: [{ name: "big.bin", type: "application/octet-stream", data }],
			chunked: true,
		});

		await expect(attempt).rejects.toBeInstanceOf(SecretApiError);
		await expect(attempt).rejects.toMatchObject({ status: 413 });
	});

	it(
		"needs the password, and spends a read on a wrong one",
		async () => {
			const client = await connect();
			const { id, keyFragment } = await client.createNote({
				format: 0,
				text: "behind a password",
				password: "correct horse battery staple",
				maxReads: 3,
			});
			expect(await client.checkNote(id)).toMatchObject({ exists: true, hasPassword: true });

			await expect(
				client.readNote(id, keyFragment, { password: "wrong", chunked: false }),
			).rejects.toBeInstanceOf(SecretDecryptionError);
			expect(await client.checkNote(id)).toMatchObject({ readCount: 1 });

			const { payload } = await client.readNote(id, keyFragment, {
				password: "correct horse battery staple",
				chunked: false,
			});
			expect(payload.text).toBe("behind a password");
		},
		ARGON2_TIMEOUT,
	);

	it(
		"protects a chunked note with the password too",
		async () => {
			const client = await connect();
			const data = bytes(2 * CHUNK_SIZE);
			const { id, keyFragment } = await client.createNote({
				format: 0,
				files: [{ name: "big.bin", type: "application/octet-stream", data }],
				password: "pw",
				chunkSize: CHUNK_SIZE,
				maxReads: 2,
			});

			await expect(client.readNote(id, keyFragment, { chunked: true })).rejects.toBeInstanceOf(
				SecretDecryptionError,
			);
			const { payload } = await client.readNote(id, keyFragment, { chunked: true, password: "pw" });
			expect(payload.files?.[0]?.data).toEqual(data);
		},
		ARGON2_TIMEOUT,
	);

	it("deletes a note with its delete token, and only with it", async () => {
		const client = await connect();
		const { id, keyFragment, deleteToken } = await client.createNote({
			format: 0,
			text: "to delete",
		});

		await expect(client.deleteNote(id, "x".repeat(deleteToken.length))).rejects.toMatchObject({
			status: 403,
			code: "wrong_delete_token",
		});
		await client.deleteNote(id, deleteToken);

		expect(await client.checkNote(id)).toMatchObject({ exists: false });
		await expect(client.readNote(id, keyFragment)).rejects.toMatchObject({ status: 404 });
	});

	it("reads without a key, but writes only with one", async () => {
		const writer = await connect();
		const { id, keyFragment } = await writer.createNote({
			format: 0,
			text: "public read",
			maxReads: 2,
		});

		const reader = await connect(null);
		const { payload } = await reader.readNote(id, keyFragment);
		expect(payload.text).toBe("public read");

		await expect(reader.createNote({ format: 0, text: "no key" })).rejects.toMatchObject({
			status: 401,
		});
	});

	it("reads a note from the share URL it builds", async () => {
		const client = await connect();
		const { id, keyFragment } = await client.createNote({ format: 0, text: "by URL" });

		const url = client.buildShareUrl(id, keyFragment);
		expect(url).toBe(`${baseUrl}/note/${id}#${keyFragment}`);
		const parsed = SecretClient.parseShareUrl(url);
		const { payload } = await client.readNote(parsed.id, parsed.keyFragment);
		expect(payload.text).toBe("by URL");
	});
});

describe("format 1, through the SDK and the application", () => {
	it("writes format 1 by default, read with its proof once /exists served its envelope", async () => {
		const client = await connect();
		const { id, keyFragment } = await client.createNote({ text: "hello, format 1", maxReads: 2 });
		expect(keyFragment).toMatch(/^1\.[A-Za-z0-9_-]{43}$/);

		expect(await client.checkNote(id)).toMatchObject({
			exists: true,
			hasPassword: false,
			chunked: false,
			fileCount: 0,
			maxReads: 2,
		});
		const { payload } = await client.readNote(id, keyFragment);
		expect(payload).toEqual({ text: "hello, format 1" });

		// The read takes the envelope from /exists, then proves the link: no GET.
		expect(calls).toEqual([
			"POST /api/v1/notes",
			"GET /api/v1/notes/:id/exists",
			"GET /api/v1/notes/:id/exists",
			"POST /api/v1/notes/:id/reads",
		]);
		expect(await client.checkNote(id)).toMatchObject({ exists: true, readCount: 1 });
	});

	it("round-trips files through the multipart upload", async () => {
		const client = await connect();
		const data = bytes(20 * 1024);
		const { id, keyFragment } = await client.createNote({
			text: "two attachments",
			files: [
				{ name: "a.bin", type: "application/octet-stream", data },
				{ name: "empty.txt", type: "text/plain", data: new Uint8Array() },
			],
			chunkSize: CHUNK_SIZE,
			format: 1,
		});
		expect(await client.checkNote(id)).toMatchObject({ chunked: false, fileCount: 2 });

		const { payload } = await client.readNote(id, keyFragment, { chunked: false });
		expect(payload.files?.map((file) => file.data)).toEqual([data, new Uint8Array()]);
		expect(calls[0]).toBe("POST /api/v1/notes/upload");
	});

	it("round-trips a chunked note", async () => {
		const client = await connect();
		const data = bytes(3 * CHUNK_SIZE + 5);
		const { id, keyFragment } = await client.createNote({
			files: [{ name: "big.bin", type: "application/octet-stream", data }],
			chunkSize: CHUNK_SIZE,
			format: 1,
		});
		expect(calls[0]).toBe("POST /api/v1/notes/upload/init");
		// Sent in a session, as /exists does not tell: it would hint at the size.
		expect(await client.checkNote(id)).toMatchObject({ chunked: false, fileCount: 1 });

		const { payload } = await client.readNote(id, keyFragment);
		expect(payload.files?.[0]?.data).toEqual(data);
	});

	it(
		"needs the password the envelope declares",
		async () => {
			const client = await connect();
			const { id, keyFragment } = await client.createNote({
				text: "behind a password",
				password: "Pässwörd".normalize("NFC"),
				format: 1,
				maxReads: 3,
			});
			expect(await client.checkNote(id)).toMatchObject({
				hasPassword: true,
				passwordAttemptsLeft: 5,
			});

			await expect(client.readNote(id, keyFragment, { password: "wrong" })).rejects.toBeInstanceOf(
				SecretDecryptionError,
			);
			// A wrong password spends no read: it counts one attempt.
			expect(await client.checkNote(id)).toMatchObject({ readCount: 0, passwordAttemptsLeft: 4 });

			// Typed in another Unicode form, the same password opens it.
			const { payload } = await client.readNote(id, keyFragment, {
				password: "Pässwörd".normalize("NFD"),
			});
			expect(payload.text).toBe("behind a password");
			expect(await client.checkNote(id)).toMatchObject({ readCount: 1, passwordAttemptsLeft: 4 });
		},
		ARGON2_TIMEOUT,
	);

	it(
		"protects a chunked note with the password too",
		async () => {
			const client = await connect();
			const data = bytes(2 * CHUNK_SIZE + 3);
			const { id, keyFragment } = await client.createNote({
				files: [{ name: "big.bin", type: "application/octet-stream", data }],
				chunkSize: CHUNK_SIZE,
				password: "chunked secret",
				format: 1,
			});
			expect(calls[0]).toBe("POST /api/v1/notes/upload/init");
			expect(await client.checkNote(id)).toMatchObject({
				chunked: false,
				hasPassword: true,
				passwordAttemptsLeft: 5,
			});

			await expect(
				client.readNote(id, keyFragment, { password: "chunked secreT" }),
			).rejects.toBeInstanceOf(SecretDecryptionError);
			expect(await client.checkNote(id)).toMatchObject({ readCount: 0, passwordAttemptsLeft: 4 });

			const { payload } = await client.readNote(id, keyFragment, { password: "chunked secret" });
			expect(payload.files?.[0]?.data).toEqual(data);
		},
		ARGON2_TIMEOUT,
	);

	it(
		"deletes a password note at its fifth wrong password",
		async () => {
			const client = await connect();
			const { id, keyFragment } = await client.createNote({
				text: "five tries",
				password: "right",
				format: 1,
				maxReads: 0,
			});

			for (const left of [4, 3, 2, 1]) {
				await expect(
					client.readNote(id, keyFragment, { password: "wrong" }),
				).rejects.toBeInstanceOf(SecretDecryptionError);
				expect(await client.checkNote(id)).toMatchObject({ passwordAttemptsLeft: left });
			}
			await expect(client.readNote(id, keyFragment, { password: "wrong" })).rejects.toBeInstanceOf(
				SecretDecryptionError,
			);
			expect(await client.checkNote(id)).toEqual({ exists: false });
			await expect(client.readNote(id, keyFragment, { password: "right" })).rejects.toMatchObject({
				status: 404,
			});
		},
		ARGON2_TIMEOUT * 2,
	);

	it(
		"counts nothing against a reader without the link",
		async () => {
			const client = await connect();
			const { id } = await client.createNote({
				text: "the link is the key",
				password: "right",
				format: 1,
				maxReads: 1,
			});
			const anotherLink = `1.${Buffer.from(randomBytes(32)).toString("base64url")}`;

			for (let i = 0; i < 6; i++) {
				await expect(
					client.readNote(id, anotherLink, { password: "right" }),
				).rejects.toBeInstanceOf(SecretDecryptionError);
			}
			expect(await client.checkNote(id)).toMatchObject({
				exists: true,
				readCount: 0,
				passwordAttemptsLeft: 5,
			});
		},
		ARGON2_TIMEOUT * 2,
	);

	it("is refused a note behind the link of the other format, and spends no read", async () => {
		const client = await connect();
		const data = bytes(2 * CHUNK_SIZE);
		const files = [{ name: "big.bin", type: "application/octet-stream", data }];
		const notes = [
			await client.createNote({ text: "format 0", format: 0, maxReads: 1 }),
			await client.createNote({ files, chunkSize: CHUNK_SIZE, format: 0, maxReads: 1 }),
			await client.createNote({ text: "format 1", format: 1, maxReads: 1 }),
			await client.createNote({ files, chunkSize: CHUNK_SIZE, format: 1, maxReads: 1 }),
		];

		for (const note of notes) {
			const format1 = note.keyFragment.startsWith("1.");
			const otherLink = format1 ? note.keyFragment.slice(2) : `1.${note.keyFragment}`;
			// Format 0's reads refuse a format 1 note; a format 0 note has no
			// envelope to derive a proof with, so the read stops at /exists.
			const read = client.readNote(note.id, otherLink);
			await (format1
				? expect(read).rejects.toMatchObject({ status: 400 })
				: expect(read).rejects.toBeInstanceOf(SecretDecryptionError));
			expect(await client.checkNote(note.id)).toMatchObject({ exists: true, readCount: 0 });
		}
	});

	// The SDK up to 1.2 reads /stream, then /raw, then the JSON read: none of
	// them may spend a read on a format 1 note, whatever format it asks for.
	it("spends no read of a format 1 note on a client that knows only format 0", async () => {
		const client = await connect();
		const { id } = await client.createNote({ text: "format 1", format: 1, maxReads: 1 });
		const { id: chunkedId } = await client.createNote({
			files: [{ name: "a.bin", type: "application/octet-stream", data: bytes(2 * CHUNK_SIZE) }],
			chunkSize: CHUNK_SIZE,
			format: 1,
			maxReads: 1,
		});

		for (const note of [id, chunkedId]) {
			for (const path of ["/stream", "/raw", "", "/stream?format=1", "/raw?format=1"]) {
				const res = await fetch(`${baseUrl}/api/v1/notes/${note}${path}`);
				expect(res.status, path).toBe(400);
			}
			expect(await client.checkNote(note)).toMatchObject({ exists: true, readCount: 0 });
		}
	});

	it("refuses a malformed format 1 link before reading anything", async () => {
		const client = await connect();
		const { id } = await client.createNote({ text: "kept", format: 1 });
		calls = [];

		await expect(client.readNote(id, "1.cut-short")).rejects.toThrow("Invalid key fragment");
		expect(calls).toEqual([]);
		expect(await client.checkNote(id)).toMatchObject({ exists: true, readCount: 0 });
	});

	it("reads a note from the share URL it builds", async () => {
		const client = await connect();
		const { id, keyFragment } = await client.createNote({ text: "by URL", format: 1 });

		const url = client.buildShareUrl(id, keyFragment);
		expect(url).toBe(`${baseUrl}/note/${id}#${keyFragment}`);
		const parsed = SecretClient.parseShareUrl(url);
		const { payload } = await client.readNote(parsed.id, parsed.keyFragment);
		expect(payload.text).toBe("by URL");
	});
});

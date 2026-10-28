import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
// Extends Zod with `.openapi()` before `@largerio/secret-shared` builds its
// schemas, which the SDK imports too (the production entry point does the same).
import "@hono/zod-openapi";
import { SecretApiError, SecretClient, SecretDecryptionError } from "@largerio/secret-sdk";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type AppEnv, createApp } from "../app.js";
import { parseConfig } from "../config.js";
import { type AppDatabase, createDatabase } from "../db/index.js";
import { pendingDeletions } from "../db/schema.js";
import { createLogger } from "../logger.js";
import { LocalStorage } from "../storage/local.js";

// The SDK and the API each have their own tests, against a mocked other side.
// Here the real client talks to the real application, through every
// middleware, so a mismatch between them (a header, a limit, a chunk size, an
// encoding) fails a test. Writes authenticate with an API key, as an SDK user
// does; the Cap widget is a browser concern.
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

let sqlite: ReturnType<typeof createDatabase>["sqlite"];
let db: AppDatabase;
let app: Hono<AppEnv>;
let stopLimiters: () => void;

function removeFiles(): void {
	for (const path of [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`]) {
		rmSync(path, { force: true });
	}
	rmSync(TEST_FILES_PATH, { recursive: true, force: true });
}

// One instance for the file, as a server would run: each test works on notes
// of its own.
beforeAll(() => {
	removeFiles();
	mkdirSync(TEST_FILES_PATH, { recursive: true });
	({ db, sqlite } = createDatabase(TEST_DB_PATH));
	const config = parseConfig({
		SERVER_ENCRYPTION_KEY: SERVER_KEY.toString("base64"),
		API_KEY,
		CHUNK_SIZE: String(CHUNK_SIZE),
	} as NodeJS.ProcessEnv);
	const created = createApp({
		db,
		serverKey: SERVER_KEY,
		storage: new LocalStorage(TEST_FILES_PATH),
		config,
		logger: createLogger({ write: () => {} }),
	});
	app = created.app;
	stopLimiters = () => {
		for (const limiter of created.rateLimiters) limiter.cleanup();
	};
});

afterAll(async () => {
	// A burned note's files are purged once its response is sent: let the last
	// purges finish before the database closes under them.
	await vi.waitFor(() => expect(db.select().from(pendingDeletions).all()).toEqual([]));
	stopLimiters();
	sqlite.close();
	removeFiles();
});

/** A client whose requests go to the app in this process, over no network. */
function connect(apiKey: string | null = API_KEY): Promise<SecretClient> {
	return SecretClient.create({
		baseUrl: "https://secret.test",
		...(apiKey ? { apiKey } : {}),
		fetch: async (input, init) =>
			app.request(input instanceof Request ? input : String(input), init),
	});
}

function bytes(size: number): Uint8Array {
	return new Uint8Array(randomBytes(size));
}

describe("the SDK against the application", () => {
	it("round-trips a text note, then finds it burned", async () => {
		const client = await connect();
		const { id, keyFragment } = await client.createNote({ text: "hello, server", maxReads: 1 });

		const info = await client.checkNote(id);
		expect(info).toMatchObject({ exists: true, hasPassword: false, chunked: false, fileCount: 0 });

		const { payload } = await client.readNote(id, keyFragment);
		expect(payload.text).toBe("hello, server");

		await expect(client.readNote(id, keyFragment)).rejects.toMatchObject({ status: 404 });
		expect(await client.checkNote(id)).toMatchObject({ exists: false });
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
		});

		const info = await client.checkNote(id);
		expect(info).toMatchObject({ exists: true, chunked: false, fileCount: 2 });

		const { payload } = await client.readNote(id, keyFragment, { chunked: false });
		expect(payload.text).toBe("two attachments");
		expect(payload.files?.map((file) => file.name)).toEqual(["a.bin", "empty.txt"]);
		expect(payload.files?.[0]?.data).toEqual(data);
		expect(payload.files?.[1]?.data).toEqual(new Uint8Array());
	});

	it("round-trips a chunked note at the instance's chunk size", async () => {
		const client = await connect();
		const data = bytes(5 * CHUNK_SIZE + 123);
		const progress: number[] = [];
		const { id, keyFragment } = await client.createNote({
			files: [{ name: "big.bin", type: "application/octet-stream", data }],
			chunkSize: CHUNK_SIZE,
			maxReads: 2,
			onProgress: (info) => progress.push(info.overallProgress),
		});
		expect(progress.at(-1)).toBe(1);

		const info = await client.checkNote(id);
		expect(info).toMatchObject({ exists: true, chunked: true, fileCount: 1, readCount: 0 });

		const first = await client.readNote(id, keyFragment, { chunked: true });
		expect(first.payload.files?.[0]?.data).toEqual(data);

		// Without the hint, the client finds the stream on its own.
		const second = await client.readNote(id, keyFragment);
		expect(second.payload.files?.[0]?.data).toEqual(data);

		await expect(client.readNote(id, keyFragment)).rejects.toMatchObject({ status: 404 });
	});

	it("refuses chunks larger than the instance's chunk size", async () => {
		const client = await connect();
		const data = bytes(3 * CHUNK_SIZE);

		// The SDK's 4 MiB default would send the whole file in one chunk.
		const attempt = client.createNote({
			files: [{ name: "big.bin", type: "application/octet-stream", data }],
			chunked: true,
		});

		await expect(attempt).rejects.toBeInstanceOf(SecretApiError);
		await expect(attempt).rejects.toMatchObject({ status: 413 });
	});

	it("needs the password, and spends a read on a wrong one", async () => {
		const client = await connect();
		const { id, keyFragment } = await client.createNote({
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
	});

	it("protects a chunked note with the password too", async () => {
		const client = await connect();
		const data = bytes(2 * CHUNK_SIZE);
		const { id, keyFragment } = await client.createNote({
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
	});

	it("deletes a note with its delete token, and only with it", async () => {
		const client = await connect();
		const { id, keyFragment, deleteToken } = await client.createNote({ text: "to delete" });

		await expect(client.deleteNote(id, "x".repeat(deleteToken.length))).rejects.toMatchObject({
			status: 403,
		});
		await client.deleteNote(id, deleteToken);

		expect(await client.checkNote(id)).toMatchObject({ exists: false });
		await expect(client.readNote(id, keyFragment)).rejects.toMatchObject({ status: 404 });
	});

	it("reads without a key, but writes only with one", async () => {
		const writer = await connect();
		const { id, keyFragment } = await writer.createNote({ text: "public read", maxReads: 2 });

		const reader = await connect(null);
		const { payload } = await reader.readNote(id, keyFragment);
		expect(payload.text).toBe("public read");

		await expect(reader.createNote({ text: "no key" })).rejects.toMatchObject({ status: 401 });
	});

	it("reads a note from the share URL it builds", async () => {
		const client = await connect();
		const { id, keyFragment } = await client.createNote({ text: "by URL" });

		const url = client.buildShareUrl(id, keyFragment);
		expect(url).toBe(`https://secret.test/note/${id}#${keyFragment}`);
		const parsed = SecretClient.parseShareUrl(url);
		const { payload } = await client.readNote(parsed.id, parsed.keyFragment);
		expect(payload.text).toBe("by URL");
	});
});

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
// Extends Zod with `.openapi()` before `@largerio/secret-shared` builds its
// schemas, as the routes expect (the production entry point does the same).
import "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AppDatabase, createDatabase } from "../db/index.js";
import { notes as notesTable } from "../db/schema.js";
import { NoteError, type NoteErrorCode } from "../notes/errors.js";
import { inStorage, placementOf } from "../notes/rows.js";
import type { NotesService } from "../notes/service.js";
import { chunkStream } from "../notes/stream.js";
import { noteErrorToHttp } from "../routes/notes/errorStatus.js";
import { StorageNotFoundError } from "../storage/index.js";
import { LocalStorage } from "../storage/local.js";
import { createTestNotesService } from "./testApp.js";

const TEST_DB_PATH = "./data/notes-service-test.db";
const TEST_FILES_PATH = "./data/notes-service-test-files";

const SETTINGS = { clientNonce: "nonce", hasPassword: false, expiresIn: 3600, maxReads: 1 };

let sqlite: ReturnType<typeof createDatabase>["sqlite"];
let db: AppDatabase;
let storage: LocalStorage;
let notes: NotesService;

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
	storage = new LocalStorage(TEST_FILES_PATH);
	notes = createTestNotesService({
		db,
		serverKey: randomBytes(32),
		storage,
		env: {
			CHUNK_SIZE: "16",
			MAX_CHUNKED_FILE_SIZE: "1024",
			MAX_EXPIRY: "86400",
			MAX_FILES_PER_NOTE: "3",
		},
	});
});

afterEach(() => {
	sqlite.close();
	removeFiles();
});

async function refusal(action: () => unknown): Promise<NoteErrorCode> {
	try {
		await action();
	} catch (err) {
		if (err instanceof NoteError) return err.code;
		throw err;
	}
	throw new Error("expected a NoteError");
}

const sha256 = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

/** A chunk as a request body yields it. */
const asBody = (data: Buffer) => async (): Promise<ArrayBuffer> => new Uint8Array(data).buffer;

/** A chunked note of the given chunks, uploaded through a session. */
async function uploadChunked(chunks: Buffer[], fileCount = 1) {
	const session = notes.openUpload({
		...SETTINGS,
		fileCount,
		streamHeader: "header",
		chunkCount: chunks.length,
	});
	for (const [index, chunk] of chunks.entries()) {
		await notes.receiveChunk({
			uploadId: session.uploadId,
			index,
			hash: sha256(chunk),
			readBody: asBody(chunk),
		});
	}
	return notes.completeUpload(session.uploadId);
}

// The service is the API without HTTP: these go through it alone.
describe("the notes service", () => {
	it("serves a single-shot note once, then forgets it", async () => {
		const { id } = await notes.create(Buffer.from("ciphertext"), { ...SETTINGS, fileCount: 0 });

		expect(notes.check(id)).toMatchObject({ maxReads: 1, readCount: 0, chunked: false });

		const { ciphertext, meta } = await notes.read(id);
		expect(ciphertext.toString()).toBe("ciphertext");
		expect(meta.clientNonce).toBe("nonce");

		expect(notes.check(id)).toBeUndefined();
		expect(await refusal(() => notes.read(id))).toBe("note_not_found");
	});

	it("applies the operator's limits", async () => {
		expect(
			await refusal(() =>
				notes.create(Buffer.from("x"), { ...SETTINGS, expiresIn: 86_401, fileCount: 0 }),
			),
		).toBe("expiry_above_limit");
		expect(await refusal(() => notes.create(Buffer.from("x"), { ...SETTINGS, fileCount: 4 }))).toBe(
			"too_many_files",
		);
		expect(
			await refusal(() =>
				notes.openUpload({ ...SETTINGS, fileCount: 1, streamHeader: "h", chunkCount: 65 }),
			),
		).toBe("too_many_chunks");
	});

	it("deletes a note only with its token", async () => {
		const { id, deleteToken } = await notes.create(Buffer.from("x"), {
			...SETTINGS,
			fileCount: 1,
		});

		expect(await refusal(() => notes.delete(id, "not-the-token"))).toBe("wrong_delete_token");
		await notes.delete(id, deleteToken);
		expect(await refusal(() => notes.delete(id, deleteToken))).toBe("note_not_found");
	});

	it("turns an upload session into a chunked note, served chunk by chunk", async () => {
		const first = Buffer.from("first chunk");
		const second = Buffer.from("second");
		const session = notes.openUpload({
			...SETTINGS,
			fileCount: 1,
			streamHeader: "header",
			chunkCount: 2,
		});
		const send = (index: number, chunk: Buffer) =>
			notes.receiveChunk({
				uploadId: session.uploadId,
				index,
				hash: sha256(chunk),
				readBody: asBody(chunk),
			});

		await send(0, first);
		expect(await refusal(() => notes.completeUpload(session.uploadId))).toBe("upload_incomplete");
		await send(1, second);
		const { id } = notes.completeUpload(session.uploadId);

		expect(notes.check(id)).toMatchObject({ chunked: true });
		expect(await refusal(() => notes.read(id))).toBe("note_is_chunked");

		const stream = await notes.stream(id);
		expect(stream).toMatchObject({ streamHeader: "header", chunkCount: 2 });
		const received: Buffer[] = [];
		for await (const chunk of stream.chunks) {
			received.push(Buffer.from(chunk));
		}
		expect(received).toEqual([first, second]);

		// Burned by its read: gone, and its chunks purged once the stream ended.
		expect(notes.check(id)).toBeUndefined();
		await vi.waitFor(() => expect(storage.readChunk(id, 0)).rejects.toThrow(StorageNotFoundError));
	});

	it("refuses a chunk before reading it when the session or the index is wrong", async () => {
		const session = notes.openUpload({
			...SETTINGS,
			fileCount: 1,
			streamHeader: "header",
			chunkCount: 1,
		});
		const readBody = vi.fn(asBody(Buffer.from("chunk")));

		expect(
			await refusal(() =>
				notes.receiveChunk({ uploadId: session.uploadId, index: 1, hash: "", readBody }),
			),
		).toBe("chunk_out_of_range");
		expect(
			await refusal(() =>
				notes.receiveChunk({ uploadId: "no-such-session", index: 0, hash: "", readBody }),
			),
		).toBe("upload_not_found");
		expect(readBody).not.toHaveBeenCalled();
	});

	it("refuses a chunked row it cannot serve before spending its read", async () => {
		const { id } = await uploadChunked([Buffer.from("head")], 0);
		// A corrupt row: chunked, without the stream header a reader needs.
		db.update(notesTable).set({ streamHeader: null }).where(eq(notesTable.id, id)).run();

		expect(await refusal(() => notes.stream(id))).toBe("note_corrupted");
		expect(notes.check(id)).toMatchObject({ readCount: 0 });
	});
});

describe("where a note is stored", () => {
	it("tells the database, a file and chunks apart", () => {
		expect(placementOf({ filePath: null, chunkCount: null })).toBe("database");
		expect(placementOf({ filePath: null, chunkCount: 0 })).toBe("database");
		expect(placementOf({ filePath: "x", chunkCount: null })).toBe("file");
		expect(placementOf({ filePath: null, chunkCount: 3 })).toBe("chunks");
	});

	it("leaves something to purge only for a file or chunks", () => {
		expect(inStorage({ filePath: null, chunkCount: null })).toBe(false);
		expect(inStorage({ filePath: "x", chunkCount: null })).toBe(true);
		expect(inStorage({ filePath: null, chunkCount: 3 })).toBe(true);
	});
});

describe("chunkStream", () => {
	it("loads nothing before the reader asks", async () => {
		const load = vi.fn(async () => Buffer.from("chunk"));
		chunkStream({ count: 3, first: Buffer.from("first"), load, onEnd: async () => {} });

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(load).not.toHaveBeenCalled();
	});

	it("ends once when a cancel races a chunk still loading", async () => {
		let release: (chunk: Buffer) => void = () => {};
		const onEnd = vi.fn(async () => {});
		const reader = chunkStream({
			count: 2,
			first: Buffer.from("first"),
			load: () =>
				new Promise<Buffer>((resolve) => {
					release = resolve;
				}),
			onEnd,
		}).getReader();

		expect(Buffer.from((await reader.read()).value ?? [])).toEqual(Buffer.from("first"));
		// Let the pull for the second chunk start and wait on its load.
		const waiting = reader.read();
		await new Promise((resolve) => setTimeout(resolve, 0));
		await reader.cancel();
		expect(await waiting).toEqual({ done: true, value: undefined });

		// The chunk lands after the cancel: it cannot be enqueued, and must not
		// end the stream a second time.
		release(Buffer.from("late"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(onEnd).toHaveBeenCalledTimes(1);
	});
});

describe("noteErrorToHttp", () => {
	it("answers a refusal with its status and message, and keeps its cause", () => {
		const cause = new Error("tag mismatch");
		const http = noteErrorToHttp(new NoteError("note_corrupted", { cause }));

		expect(http).toBeInstanceOf(HTTPException);
		expect(http?.status).toBe(500);
		expect(http?.message).toBe("Failed to decrypt note");
		expect(http?.cause).toBe(cause);
		expect(noteErrorToHttp(new NoteError("note_not_found"))?.status).toBe(404);
	});

	it("leaves any other error alone", () => {
		expect(noteErrorToHttp(new Error("not ours"))).toBeUndefined();
	});
});

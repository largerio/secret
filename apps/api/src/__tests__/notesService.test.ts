import { createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
// Extends Zod with `.openapi()` before `@largerio/secret-shared` builds its
// schemas, as the routes expect (the production entry point does the same).
import "@hono/zod-openapi";
import { SECRETSTREAM_ABYTES } from "@largerio/secret-crypto";
import { BODY_FLOOR, encodeEnvelope, MAX_PASSWORD_ATTEMPTS } from "@largerio/secret-shared";
import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AppDatabase, createDatabase } from "../db/index.js";
import { notes as notesTable, pendingDeletions } from "../db/schema.js";
import { NoteError, type NoteErrorCode } from "../notes/errors.js";
import { assertPadded } from "../notes/padding.js";
import {
	inStorage,
	placementOf,
	settlePasswordAttempt,
	takePasswordAttempt,
} from "../notes/rows.js";
import { createServerLayer, SEALED_CHUNK_OVERHEAD } from "../notes/serverLayer.js";
import type { NotesService } from "../notes/service.js";
import { chunkStream } from "../notes/stream.js";
import type { ChunkedOpening, NoteSettings } from "../notes/types.js";
import { noteErrorToHttp } from "../routes/notes/errorStatus.js";
import { StorageNotFoundError } from "../storage/index.js";
import { LocalStorage } from "../storage/local.js";
import { createTestNotesService } from "./testApp.js";

const TEST_DB_PATH = "./data/notes-service-test.db";
const TEST_FILES_PATH = "./data/notes-service-test-files";

const SETTINGS = {
	hasPassword: false,
	expiresIn: 3600,
	maxReads: 1,
	opening: { format: 0, clientNonce: "nonce" },
} as const;

const CHUNKED_SETTINGS = {
	...SETTINGS,
	opening: { format: 0, clientNonce: "nonce", streamHeader: "header" },
} as const;

// A format 1 reader's proofs. Random: the server only ever sees them, and the
// verifiers, as bytes.
const LINK_PROOF = randomBytes(32);
const PASSWORD_PROOF = randomBytes(32);
const PROOFS = { linkProof: LINK_PROOF, passwordProof: PASSWORD_PROOF };
const verifierOf = (proof: Uint8Array): Uint8Array => createHash("sha256").update(proof).digest();

// A format 1 note's one message: the smallest body there is, and its tag.
// Random: the server never opens the client's layer, it only checks lengths.
const MESSAGE = randomBytes(BODY_FLOOR + SECRETSTREAM_ABYTES);

/**
 * A format 1 note's settings: what its envelope says, the envelope, and the
 * verifiers of the proofs above.
 */
function format1Settings(
	fileCount: number,
	options: { readonly password?: boolean; readonly maxReads?: number } = {},
) {
	const declared = { fileCount, maxReads: options.maxReads ?? 1, expiresIn: 3600 };
	const argon2 = options.password
		? { argon2: { salt: new Uint8Array(16).fill(9), iterations: 3, memoryKiB: 262_144 } }
		: {};
	const envelope = Buffer.from(
		encodeEnvelope({ streamHeader: new Uint8Array(24).fill(7), ...declared, ...argon2 }),
	);
	return {
		...declared,
		hasPassword: options.password === true,
		opening: { format: 1, envelope },
		verifiers: {
			link: verifierOf(LINK_PROOF),
			...(options.password ? { password: verifierOf(PASSWORD_PROOF) } : {}),
		},
	} as const;
}

/** A format 1 note of the given messages, through its upload session. */
async function uploadFormat1(
	settings: NoteSettings<ChunkedOpening> = format1Settings(1),
	messages: readonly Buffer[] = [MESSAGE],
) {
	const session = notes.openUpload({ ...settings, chunkCount: messages.length });
	for (const [index, message] of messages.entries()) {
		await notes.receiveChunk({
			uploadId: session.uploadId,
			index,
			hash: sha256(message),
			readBody: asBody(message),
		});
	}
	return { ...notes.completeUpload(session.uploadId), settings };
}

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
			CHUNK_SIZE: "4096",
			MAX_CHUNKED_FILE_SIZE: "262144",
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

/** A stream's chunks, read to its end. */
async function chunksOf(chunks: ReadableStream<Uint8Array>): Promise<Buffer[]> {
	const received: Buffer[] = [];
	for await (const chunk of chunks) {
		received.push(Buffer.from(chunk));
	}
	return received;
}

/** A chunked note of the given chunks, uploaded through a session. */
async function uploadChunked(chunks: Buffer[], fileCount = 1) {
	const session = notes.openUpload({
		...CHUNKED_SETTINGS,
		fileCount,
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
		expect(meta.opening.clientNonce).toBe("nonce");

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
			await refusal(() => notes.openUpload({ ...CHUNKED_SETTINGS, fileCount: 1, chunkCount: 65 })),
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
			...CHUNKED_SETTINGS,
			fileCount: 1,
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
		expect(stream).toMatchObject({ meta: { opening: { streamHeader: "header" } }, chunkCount: 2 });
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
			...CHUNKED_SETTINGS,
			fileCount: 1,
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

	it("refuses a format 1 row whose envelope does not parse, before spending its read", async () => {
		const { id: whole } = await notes.create(MESSAGE, format1Settings(0));
		const { id: inSession } = await uploadFormat1();

		for (const id of [whole, inSession]) {
			db.update(notesTable)
				.set({ envelope: Buffer.from("garbage") })
				.where(eq(notesTable.id, id))
				.run();

			expect(await refusal(() => notes.readWithProofs(id, PROOFS))).toBe("note_corrupted");
			expect(notes.check(id)).toMatchObject({ readCount: 0 });
		}
	});

	it("refuses a note in another format than the read's, before spending its read", async () => {
		const settings = format1Settings(0);
		const { id } = await notes.create(MESSAGE, settings);
		const format0 = await notes.create(Buffer.from("old"), { ...SETTINGS, fileCount: 0 });
		const { id: chunked } = await uploadFormat1();

		expect(await refusal(() => notes.read(id))).toBe("note_format_mismatch");
		expect(await refusal(() => notes.read(chunked))).toBe("note_format_mismatch");
		expect(await refusal(() => notes.stream(chunked))).toBe("note_format_mismatch");
		expect(await refusal(() => notes.stream(id))).toBe("note_format_mismatch");
		expect(await refusal(() => notes.readWithProofs(format0.id, PROOFS))).toBe(
			"note_format_mismatch",
		);
		for (const note of [id, format0.id, chunked]) {
			expect(notes.check(note)).toMatchObject({ readCount: 0 });
		}

		const read = await notes.readWithProofs(id, PROOFS);
		expect(read.meta.opening.envelope).toEqual(settings.opening.envelope);
		expect(await chunksOf(read.chunks)).toEqual([MESSAGE]);
		expect(notes.check(id)).toBeUndefined();
	});

	// A reader reads a format 1 note the same way, however it went up.
	it("serves a format 1 note sent whole as its one message, as a session's are served", async () => {
		const settings = format1Settings(1);
		const { id: whole } = await notes.create(MESSAGE, settings);
		const { id: inSession } = await uploadFormat1(settings);

		for (const id of [whole, inSession]) {
			const read = await notes.readWithProofs(id, PROOFS);

			expect(read).toMatchObject({ chunkCount: 1, meta: { opening: settings.opening } });
			expect(await chunksOf(read.chunks)).toEqual([MESSAGE]);
			expect(notes.check(id)).toBeUndefined();
		}
		// Both burned: their purges run in the background.
		await vi.waitFor(() => expect(db.select().from(pendingDeletions).all()).toEqual([]));
		expect(await Array.fromAsync(storage.list())).toEqual([]);
	});
});

describe("format 1 message lengths", () => {
	const message = (bodyBytes: number): Buffer => randomBytes(bodyBytes + SECRETSTREAM_ABYTES);

	it("takes a note sent whole whose body is a size class, and refuses any other", async () => {
		for (const body of [BODY_FLOOR, 4352, 8192]) {
			const { id } = await notes.create(message(body), format1Settings(1));
			expect(notes.check(id)).toMatchObject({ chunked: false });
		}

		for (const body of [0, 1, BODY_FLOOR - 1, BODY_FLOOR + 1, 4353, 8193]) {
			expect(
				await refusal(() => notes.create(message(body), format1Settings(1))),
				String(body),
			).toBe("note_not_padded");
		}
		// Refused before anything is stored.
		expect(db.select().from(notesTable).all()).toHaveLength(3);
		expect(await Array.fromAsync(storage.list())).toHaveLength(3);
	});

	it("leaves format 0 alone, whatever its length", async () => {
		const { id } = await notes.create(Buffer.from("x"), { ...SETTINGS, fileCount: 0 });

		expect(notes.check(id)).toMatchObject({ chunked: false });
	});

	it("takes a session of messages cut evenly, its last no longer, its body a size class", async () => {
		const cuts = [
			[BODY_FLOOR],
			[2048, 2048],
			[4096, 256],
			[1024, 1024, 1024, 1024],
			[3000, 3000, 2192],
		];
		for (const cut of cuts) {
			const { id } = await uploadFormat1(format1Settings(1), cut.map(message));

			expect(notes.check(id), cut.join()).toMatchObject({ chunked: true });
		}
	});

	it("refuses a session whose messages break the body's rules, and creates no note", async () => {
		const refused = [
			// A short message before the last.
			[2048, 1024, 1024],
			// A last message longer than the first.
			[1024, 3072],
			// A body that is not a size class.
			[2048, 2047],
			[BODY_FLOOR - 1],
			[4096, 1],
		];
		for (const cut of refused) {
			expect(
				await refusal(() => uploadFormat1(format1Settings(1), cut.map(message))),
				cut.join(),
			).toBe("note_not_padded");
		}
		expect(db.select().from(notesTable).all()).toEqual([]);
	});

	it("leaves a refused session as it was, its chunks in the storage, to complete or expire", async () => {
		const settings = format1Settings(1);
		const session = notes.openUpload({ ...settings, chunkCount: 2 });
		const send = (index: number, chunk: Buffer) =>
			notes.receiveChunk({
				uploadId: session.uploadId,
				index,
				hash: sha256(chunk),
				readBody: asBody(chunk),
			});
		await send(0, message(2048));
		await send(1, message(2047));

		expect(await refusal(() => notes.completeUpload(session.uploadId))).toBe("note_not_padded");
		expect(await refusal(() => notes.completeUpload(session.uploadId))).toBe("note_not_padded");
		expect(await Array.fromAsync(storage.list())).toHaveLength(1);

		// Sent again, under the same index, at the right length, it completes.
		await send(1, message(2048));
		const { id } = notes.completeUpload(session.uploadId);
		expect(notes.check(id)).toMatchObject({ chunked: true });
	});

	it("reads the messages' lengths from their sealed sizes", () => {
		const layer = createServerLayer(randomBytes(32));

		expect(layer.sealChunk("aBcDeFgHiJkL", MESSAGE)).toHaveLength(
			MESSAGE.length + SEALED_CHUNK_OVERHEAD,
		);
	});

	it("refuses an empty last message, and a note of no message", () => {
		const padded = BODY_FLOOR + SECRETSTREAM_ABYTES;

		expect(() => assertPadded([padded])).not.toThrow();
		// The body adds up, but its last message holds nothing, or less than a tag.
		expect(() => assertPadded([padded, SECRETSTREAM_ABYTES])).toThrow(NoteError);
		expect(() => assertPadded([padded + 1, SECRETSTREAM_ABYTES - 1])).toThrow(NoteError);
		expect(() => assertPadded([])).toThrow(NoteError);
	});
});

describe("format 1 proofs, in the service", () => {
	it("tells what a reader needs to prove anything, and spends nothing for it", async () => {
		const plain = await notes.create(MESSAGE, format1Settings(0));
		const withPassword = await notes.create(MESSAGE, format1Settings(0, { password: true }));
		const format0 = await notes.create(Buffer.from("x"), { ...SETTINGS, fileCount: 0 });

		expect(notes.check(plain.id)).toEqual(
			expect.objectContaining({
				envelope: format1Settings(0).opening.envelope,
			}),
		);
		expect(notes.check(plain.id)).not.toHaveProperty("passwordAttemptsLeft");
		expect(notes.check(withPassword.id)).toMatchObject({
			hasPassword: true,
			passwordAttemptsLeft: MAX_PASSWORD_ATTEMPTS,
		});
		expect(notes.check(format0.id)).not.toHaveProperty("envelope");
		expect(notes.check(format0.id)).not.toHaveProperty("passwordAttemptsLeft");
	});

	it("refuses a wrong link proof without counting anything, whatever the password proof", async () => {
		const { id } = await notes.create(MESSAGE, format1Settings(0, { password: true }));

		expect(
			await refusal(() =>
				notes.readWithProofs(id, { linkProof: PASSWORD_PROOF, passwordProof: PASSWORD_PROOF }),
			),
		).toBe("wrong_link_proof");
		expect(notes.check(id)).toMatchObject({
			readCount: 0,
			passwordAttemptsLeft: MAX_PASSWORD_ATTEMPTS,
		});
	});

	it("counts wrong passwords over the note's life, and deletes it on the last", async () => {
		const { id } = await notes.create(MESSAGE, format1Settings(1, { password: true, maxReads: 0 }));
		const wrong = { linkProof: LINK_PROOF, passwordProof: LINK_PROOF };

		expect(await refusal(() => notes.readWithProofs(id, { linkProof: LINK_PROOF }))).toBe(
			"password_proof_missing",
		);
		expect(await refusal(() => notes.readWithProofs(id, wrong))).toBe("wrong_password");
		// A read that succeeds does not reset the count.
		expect((await notes.readWithProofs(id, PROOFS)).chunkCount).toBe(1);
		expect(notes.check(id)).toMatchObject({ passwordAttemptsLeft: MAX_PASSWORD_ATTEMPTS - 1 });

		for (let left = MAX_PASSWORD_ATTEMPTS - 2; left > 0; left -= 1) {
			expect(await refusal(() => notes.readWithProofs(id, wrong))).toBe("wrong_password");
			expect(notes.check(id)).toMatchObject({ passwordAttemptsLeft: left });
		}
		// The last one it takes: refused like the others, and the note is gone.
		expect(await refusal(() => notes.readWithProofs(id, wrong))).toBe("wrong_password");

		expect(notes.check(id)).toBeUndefined();
		expect(await refusal(() => notes.readWithProofs(id, PROOFS))).toBe("note_not_found");
		// Its file is purged, as a burn's would be.
		await vi.waitFor(() => expect(db.select().from(pendingDeletions).all()).toEqual([]));
		expect(await Array.fromAsync(storage.list())).toEqual([]);
	});

	it("takes no attempt on a note that is gone, and settles none", () => {
		expect(takePasswordAttempt(db, "no-such-note")).toEqual({ status: "missing" });
		for (const proven of [true, false]) {
			expect(() => settlePasswordAttempt(db, "no-such-note", proven)).toThrow(
				expect.objectContaining({ code: "note_not_found" }),
			);
		}
	});

	it("ignores a password proof sent for a note without a password", async () => {
		const { id } = await notes.create(MESSAGE, format1Settings(0));

		const read = await notes.readWithProofs(id, {
			linkProof: LINK_PROOF,
			passwordProof: LINK_PROOF,
		});

		expect(await chunksOf(read.chunks)).toEqual([MESSAGE]);
	});

	// The routes always give a format 1 write its verifiers (the request schemas
	// require them). A write that came without would make a note no proof opens:
	// refused as the corrupt note it is, never served.
	it("never serves a format 1 note written without verifiers", async () => {
		const { verifiers: _, ...settings } = format1Settings(1);
		const { id } = await notes.create(MESSAGE, settings);

		expect(await refusal(() => notes.readWithProofs(id, PROOFS))).toBe("note_corrupted");
		expect(await refusal(() => uploadFormat1(settings))).toBe("upload_corrupted");
	});
});

describe("the server layer's verifiers", () => {
	const serverKey = randomBytes(32);
	const layer = createServerLayer(serverKey);
	const id = "aBcDeFgHiJkL";
	const verifier = verifierOf(LINK_PROOF);
	const passwordVerifier = verifierOf(PASSWORD_PROOF);
	const envelope = format1Settings(0, { password: true }).opening.envelope;
	const withoutPassword = format1Settings(0).opening.envelope;

	it("seals a verifier as PROTOCOL.md says: HMAC-SHA256 of its role, the id, the envelope's hash and the verifier, under an HKDF key", () => {
		const key = Buffer.from(
			hkdfSync("sha256", serverKey, new Uint8Array(32), "secret/server verifier", 32),
		);
		const expected = (role: string, writers: Uint8Array) =>
			createHmac("sha256", key)
				.update(
					Buffer.concat([
						Buffer.from(role, "ascii"),
						Buffer.from([0]),
						Buffer.from(id, "ascii"),
						createHash("sha256").update(envelope).digest(),
						writers,
					]),
				)
				.digest();

		const sealed = layer.sealVerifiers(id, envelope, {
			link: verifier,
			password: passwordVerifier,
		});

		expect(sealed).toEqual({
			link: expected("link", verifier),
			password: expected("password", passwordVerifier),
		});
		expect(sealed.link.equals(Buffer.from(verifier))).toBe(false);
	});

	it("binds a sealed verifier to its role, its note and its envelope", () => {
		const { link } = layer.sealVerifiers(id, envelope, { link: verifier });

		// The same verifier, sealed as the password's, for another note, or with
		// another envelope: none is the link's.
		const asPassword = layer.sealVerifiers(id, envelope, {
			link: passwordVerifier,
			password: verifier,
		}).password;
		const elsewhere = layer.sealVerifiers("zYxWvUtSrQpO", envelope, { link: verifier }).link;
		const otherEnvelope = layer.sealVerifiers(id, withoutPassword, { link: verifier }).link;
		for (const sealed of [asPassword, elsewhere, otherEnvelope]) {
			expect(sealed).toHaveLength(32);
			expect(sealed?.equals(link)).toBe(false);
		}
	});

	it("checks a proof against the verifier sealed for its role, its note and its envelope", () => {
		const { link, password } = layer.sealVerifiers(id, envelope, {
			link: verifier,
			password: passwordVerifier,
		});

		expect(layer.proves(id, envelope, "link", LINK_PROOF, link)).toBe(true);
		expect(password && layer.proves(id, envelope, "password", PASSWORD_PROOF, password)).toBe(true);
		expect(layer.proves(id, envelope, "link", PASSWORD_PROOF, link)).toBe(false);
		// The link's verifier taken for the password's: the link's proof does not
		// open it as the password's.
		expect(layer.proves(id, envelope, "password", LINK_PROOF, link)).toBe(false);
		// With its envelope rewritten, or moved to another note, a verifier proves
		// nothing; nor does the verifier sent as a proof.
		expect(layer.proves(id, withoutPassword, "link", LINK_PROOF, link)).toBe(false);
		expect(layer.proves("zYxWvUtSrQpO", envelope, "link", LINK_PROOF, link)).toBe(false);
		expect(layer.proves(id, envelope, "link", verifier, link)).toBe(false);
		// Under another instance key, nothing matches either.
		expect(createServerLayer(randomBytes(32)).proves(id, envelope, "link", LINK_PROOF, link)).toBe(
			false,
		);
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

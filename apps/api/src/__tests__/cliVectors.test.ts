import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ServerType, serve } from "@hono/node-server";
// Extends Zod with `.openapi()` before `@largerio/secret-shared` builds its
// schemas, which the SDK imports too (the production entry point does the same).
import "@hono/zod-openapi";
import { type Io, run } from "@largerio/secret-cli";
import { deriveFormat1Keys, initSodium, verifierOf } from "@largerio/secret-crypto";
import {
	type Format1InvalidNoteVector,
	type Format1NoteVector,
	type Format1PayloadVector,
	parseEnvelope,
	testVectors,
} from "@largerio/secret-shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type AppDatabase, createDatabase } from "../db/index.js";
import { pendingDeletions } from "../db/schema.js";
import { LocalStorage } from "../storage/local.js";
import { createTestApp } from "./testApp.js";

// The protocol's test vectors, sent to the application as their writer would
// have, then read by the command line as a user reads a link: what the vectors
// hold must come out of `secret read` byte for byte, and what a reader must
// refuse must leave nothing behind, neither on stdout nor on disk.

const TEST_DB_PATH = "./data/cli-vectors-test.db";
const TEST_FILES_PATH = "./data/cli-vectors-test-files";
const SERVER_KEY = randomBytes(32);
const API_KEY = randomBytes(32).toString("base64url");
// Argon2id at libsodium's moderate setting (256 MiB), for the format 0
// vector behind a password, runs in several test files at once.
const ARGON2_TIMEOUT = 30_000;
/** How a format 0 vector is sent: its settings are not part of it. */
const FORMAT_0_SETTINGS = { expiresIn: 3600, maxReads: 1 };

const { format1, pipeline, secretstream } = testVectors.vectors;

/**
 * What the instance refuses of the invalid notes, by description: what it can
 * tell from the lengths and the envelope it checks. The command line reads
 * the others.
 */
const REFUSED_AT_UPLOAD: ReadonlyMap<string, string> = new Map([
	// A session of no message.
	["no message", "400 invalid_request"],
	// Its one message holds no body: shorter than its tag.
	["a message shorter than 17 bytes", "400 note_not_padded"],
	["a body without padding", "400 note_not_padded"],
	// More than a note holds, declared in the envelope.
	["eleven files", "400 invalid_request"],
]);

let sqlite: ReturnType<typeof createDatabase>["sqlite"];
let db: AppDatabase;
let server: ServerType;
let baseUrl: string;
let stopApp: () => void;
const workDirs: string[] = [];

function removeFiles(): void {
	for (const path of [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`]) {
		rmSync(path, { force: true });
	}
	rmSync(TEST_FILES_PATH, { recursive: true, force: true });
}

beforeAll(async () => {
	await initSodium();
	removeFiles();
	mkdirSync(TEST_FILES_PATH, { recursive: true });
	({ db, sqlite } = createDatabase(TEST_DB_PATH));
	const { app, stop } = createTestApp({
		db,
		serverKey: SERVER_KEY,
		storage: new LocalStorage(TEST_FILES_PATH),
		env: { API_KEY },
	});
	stopApp = stop;
	const port = await new Promise<number>((resolve) => {
		server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info: AddressInfo) =>
			resolve(info.port),
		);
	});
	baseUrl = `http://127.0.0.1:${String(port)}`;
});

afterAll(async () => {
	// A note sent in a session and read for the last time is purged once its
	// stream ends, after the response: let the last purges finish before the
	// database closes under them.
	await vi.waitFor(() => expect(db.select().from(pendingDeletions).all()).toEqual([]));
	await new Promise((resolve) => server.close(resolve));
	stopApp();
	sqlite.close();
	removeFiles();
	await Promise.all(workDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function workDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "secret-cli-vectors-"));
	workDirs.push(dir);
	return dir;
}

class Output {
	readonly isTTY = false;
	text = "";

	write(text: string): void {
		this.text += text;
	}
}

/** `secret read <link> --out <dir>`, with the vector's password if it has one. */
async function read(link: string, password: string | undefined, args: ReadonlyArray<string> = []) {
	const out = await workDir();
	const stdout = new Output();
	const stderr = new Output();
	const io: Io = {
		stdin: { isTTY: false, async *[Symbol.asyncIterator]() {} },
		stdout,
		stderr,
		env: password === undefined ? {} : { SECRET_PASSWORD: password },
		cwd: await workDir(),
		fetch,
		signal: new AbortController().signal,
	};
	const code = await run(["read", link, "--out", out, ...args], io);
	return { code, stdout: stdout.text, stderr: stderr.text, out };
}

/** The files of a directory, by name: what `secret read` left there. */
async function filesIn(dir: string): Promise<Record<string, Buffer>> {
	const files: Record<string, Buffer> = {};
	for (const name of await readdir(dir)) {
		files[name] = await readFile(join(dir, name));
	}
	return files;
}

/** The files a vector's payload holds, by name. */
function filesOf(payload: Format1PayloadVector): Record<string, Buffer> {
	return Object.fromEntries(
		(payload.files ?? []).map((file) => [file.name, Buffer.from(file.data, "base64")]),
	);
}

type Deposit = { readonly id: string } | { readonly refused: string };

/** A write's answer: the note created, or the status and code of its refusal. */
async function depositOf(res: Response): Promise<Deposit> {
	const body = (await res.json()) as { id?: string; code?: string };
	if (res.status === 201 && body.id !== undefined) {
		return { id: body.id };
	}
	return { refused: `${String(res.status)} ${String(body.code)}` };
}

function post(path: string, body: unknown): Promise<Response> {
	return fetch(`${baseUrl}/api/v1${path}`, {
		method: "POST",
		headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

/** Sends messages in an upload session, opened with `fields`. */
async function sendInSession(
	fields: Record<string, unknown>,
	messages: ReadonlyArray<string>,
): Promise<Deposit> {
	const init = await post("/notes/upload/init", { ...fields, chunkCount: messages.length });
	if (init.status !== 201) {
		return depositOf(init);
	}
	const { uploadId } = (await init.json()) as { uploadId: string };
	for (const [index, message] of messages.entries()) {
		const bytes = Buffer.from(message, "base64");
		const res = await fetch(`${baseUrl}/api/v1/notes/upload/${uploadId}/chunks/${String(index)}`, {
			method: "PUT",
			headers: {
				"Content-Type": "application/octet-stream",
				"X-Chunk-Hash": createHash("sha256").update(bytes).digest("hex"),
			},
			body: new Uint8Array(bytes) as BodyInit,
		});
		if (res.status !== 200) {
			return depositOf(res);
		}
	}
	return depositOf(
		await fetch(`${baseUrl}/api/v1/notes/upload/${uploadId}/complete`, { method: "POST" }),
	);
}

/**
 * The verifiers a writer sends beside a format 1 envelope (PROTOCOL.md,
 * "Keys"): the link's, and the password's for a password note, derived with
 * the envelope's Argon2id parameters.
 */
function verifiersOf(vector: Format1NoteVector | Format1InvalidNoteVector): Record<string, string> {
	const linkKey = new Uint8Array(Buffer.from(vector.keyFragment.slice(2), "base64url"));
	const argon2 = parseEnvelope(Buffer.from(vector.envelope, "base64"))?.argon2;
	const keys = deriveFormat1Keys(
		linkKey,
		vector.password === undefined || argon2 === undefined
			? undefined
			: { password: vector.password, argon2 },
	);
	const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
	return {
		linkVerifier: base64(verifierOf(keys.linkProof)),
		...(keys.passwordProof === undefined
			? {}
			: { passwordVerifier: base64(verifierOf(keys.passwordProof)) }),
	};
}

/**
 * Sends a format 1 note as its messages are: one in one request, any other
 * number in an upload session.
 */
async function depositFormat1(vector: Format1NoteVector | Format1InvalidNoteVector) {
	const fields = { envelope: vector.envelope, ...verifiersOf(vector) };
	const [only, ...rest] = vector.messages;
	if (only !== undefined && rest.length === 0) {
		return depositOf(await post("/notes", { ...fields, encryptedData: only }));
	}
	return sendInSession(fields, vector.messages);
}

/** The id of a note the instance took. */
function idOf(deposit: Deposit): string {
	expect(deposit).toEqual({ id: expect.any(String) });
	return (deposit as { id: string }).id;
}

const linkOf = (id: string, keyFragment: string) => `${baseUrl}/note/${id}#${keyFragment}`;

async function existsOf(id: string): Promise<unknown> {
	return (await fetch(`${baseUrl}/api/v1/notes/${id}/exists`)).json();
}

describe("the format 1 vectors, read by the command line", () => {
	it.each(format1.notes)("reads $description", async (vector) => {
		const id = idOf(await depositFormat1(vector));

		const outcome = await read(linkOf(id, vector.keyFragment), vector.password);

		expect(outcome.code, outcome.stderr).toBe(0);
		expect(outcome.stdout).toBe(vector.payload.text ?? "");
		expect(await filesIn(outcome.out)).toEqual(filesOf(vector.payload));
		// The note's last read is told by the reads its envelope allows.
		const maxReads = parseEnvelope(Buffer.from(vector.envelope, "base64"))?.maxReads;
		expect(outcome.stderr.split("\n")).toEqual([
			...(vector.payload.files ?? []).map((file) =>
				expect.stringContaining(`Saved ${join(outcome.out, file.name)} (`),
			),
			...(maxReads === 1 ? ["That was the note's last read: it is deleted."] : []),
			"",
		]);
	});

	it.each(format1.notes)("reads $description, in JSON", async (vector) => {
		const id = idOf(await depositFormat1(vector));

		const outcome = await read(linkOf(id, vector.keyFragment), vector.password, ["--json"]);

		expect(outcome).toMatchObject({ code: 0, stderr: "" });
		const files = vector.payload.files ?? [];
		expect(JSON.parse(outcome.stdout)).toEqual({
			...(vector.payload.text === undefined ? {} : { text: vector.payload.text }),
			...(vector.payload.contentMode === undefined
				? {}
				: { contentMode: vector.payload.contentMode }),
			files: files.map(({ name, type, size }) => ({
				name,
				path: join(outcome.out, name),
				type,
				size,
			})),
			createdAt: expect.any(String),
			expiresAt: expect.any(String),
		});
		expect(await filesIn(outcome.out)).toEqual(filesOf(vector.payload));
	});

	const refused = format1.invalid.notes.filter((v) => REFUSED_AT_UPLOAD.has(v.description));
	const accepted = format1.invalid.notes.filter((v) => !REFUSED_AT_UPLOAD.has(v.description));

	it("names invalid notes of the vectors, those the instance refuses at upload", () => {
		expect(refused.map((v) => v.description)).toEqual([...REFUSED_AT_UPLOAD.keys()]);
		expect(accepted.length).toBeGreaterThan(0);
	});

	it.each(refused)("is refused at upload: $description", async (vector) => {
		expect(await depositFormat1(vector)).toEqual({
			refused: REFUSED_AT_UPLOAD.get(vector.description),
		});
	});

	it.each(accepted)("refuses $rule: $description, leaving nothing behind", async (vector) => {
		const id = idOf(await depositFormat1(vector));

		const outcome = await read(linkOf(id, vector.keyFragment), vector.password);

		expect(outcome).toMatchObject({
			code: 4,
			stdout: "",
			stderr: "secret: wrong password, or the link is wrong or damaged\n",
		});
		// Neither a file nor a `.part` one.
		expect(await readdir(outcome.out)).toEqual([]);
		// The proofs checked out, the instance served the note and spent its one
		// read: the command line refused what it read, not the link.
		expect(await existsOf(id)).toEqual({ exists: false });
	});
});

describe("the format 0 vectors, read by the command line", () => {
	it.each(pipeline)(
		"reads $description, a note sent in one request",
		async (vector) => {
			const deposit = await depositOf(
				await post("/notes", {
					encryptedData: vector.ciphertext,
					clientNonce: vector.nonce,
					hasPassword: vector.password !== undefined,
					...(vector.salt === undefined ? {} : { salt: vector.salt }),
					fileCount: vector.payload.files?.length ?? 0,
					...FORMAT_0_SETTINGS,
				}),
			);
			// The link holds the base key, which a password note's key is derived from.
			const keyFragment = Buffer.from(vector.baseKey ?? vector.key, "base64").toString("base64url");

			const outcome = await read(linkOf(idOf(deposit), keyFragment), vector.password);

			expect(outcome.code, outcome.stderr).toBe(0);
			expect(outcome.stdout).toBe(vector.payload.text);
			expect(await filesIn(outcome.out)).toEqual(filesOf(vector.payload));
		},
		ARGON2_TIMEOUT,
	);

	it.each(secretstream)("reads $description, a note sent in a session", async (vector) => {
		const deposit = await sendInSession(
			{
				streamHeader: vector.header,
				// Not used by a note sent in a session, but required.
				clientNonce: randomBytes(24).toString("base64"),
				hasPassword: false,
				fileCount: vector.payload.files?.length ?? 0,
				...FORMAT_0_SETTINGS,
			},
			vector.chunks,
		);

		const outcome = await read(linkOf(idOf(deposit), vector.keyFragment), undefined);

		expect(outcome.code, outcome.stderr).toBe(0);
		expect(outcome.stdout).toBe(vector.payload.text);
		expect(await filesIn(outcome.out)).toEqual(filesOf(vector.payload));
	});
});

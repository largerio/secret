import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ServerType, serve } from "@hono/node-server";
// Extends Zod with `.openapi()` before `@largerio/secret-shared` builds its
// schemas, which the SDK imports too (the production entry point does the same).
import "@hono/zod-openapi";
import { type Io, run, type Terminal } from "@largerio/secret-cli";
import { deriveFormat1Keys, initSodium } from "@largerio/secret-crypto";
import { SecretClient } from "@largerio/secret-sdk";
import { sizeClass } from "@largerio/secret-shared";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type AppDatabase, createDatabase } from "../db/index.js";
import { pendingDeletions } from "../db/schema.js";
import { LocalStorage } from "../storage/local.js";
import { createTestApp } from "./testApp.js";

// The command line has its own tests, against a faked SDK, terminal and disk.
// Here it runs as a user runs it: the real SDK, the real proof of work and
// real files, against the real application over HTTP. Only its streams are
// faked, and the terminal of the tests that type a password: the others give
// it in SECRET_PASSWORD, as a script does.

const TEST_DB_PATH = "./data/cli-test.db";
const TEST_FILES_PATH = "./data/cli-test-files";
const SERVER_KEY = randomBytes(32);
const API_KEY = randomBytes(32).toString("base64url");
// Far below the 4 MiB default, so a note sent in a session needs only a few hundred KiB.
const CHUNK_SIZE = 64 * 1024;
// Argon2id at libsodium's moderate setting (256 MiB) runs in several test
// files at once.
const ARGON2_TIMEOUT = 30_000;
const PASSWORD = "correct horse battery staple";
const WRONG_PASSWORD = "Tr0ub4dor&3";
const NOT_FOUND =
	"secret: this note does not exist: it expired, was already read, or never existed\n";
const WRONG_PASSWORD_OR_LINK = "secret: wrong password, or the link is wrong or damaged\n";

let sqlite: ReturnType<typeof createDatabase>["sqlite"];
let db: AppDatabase;
let server: ServerType;
let baseUrl: string;
let stopApp: () => void;
const workDirs: string[] = [];

/** Every key and password the tests used: none of them may ever reach stderr. */
const secrets = new Set<string>([PASSWORD, WRONG_PASSWORD]);
/** The runs of the test under way. */
let outcomes: Outcome[] = [];

function removeFiles(): void {
	for (const path of [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`]) {
		rmSync(path, { force: true });
	}
	rmSync(TEST_FILES_PATH, { recursive: true, force: true });
}

// One instance for the file, as a server runs: each test works on notes of its
// own. Its proof of work is Cap's, few and easy challenges.
beforeAll(async () => {
	await initSodium();
	removeFiles();
	mkdirSync(TEST_FILES_PATH, { recursive: true });
	({ db, sqlite } = createDatabase(TEST_DB_PATH));
	const { app, stop } = createTestApp({
		db,
		serverKey: SERVER_KEY,
		storage: new LocalStorage(TEST_FILES_PATH),
		env: {
			API_KEY,
			CHUNK_SIZE: String(CHUNK_SIZE),
			CAP_CHALLENGE_COUNT: "4",
			CAP_DIFFICULTY: "2",
		},
	});
	stopApp = stop;
	const port = await new Promise<number>((resolve) => {
		server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info: AddressInfo) =>
			resolve(info.port),
		);
	});
	baseUrl = `http://127.0.0.1:${String(port)}`;
});

afterEach(() => {
	const runs = outcomes;
	outcomes = [];
	for (const { stderr } of runs) {
		for (const value of secrets) {
			expect(stderr).not.toContain(value);
		}
	}
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

/** A directory of the test's own: where a command runs, or where it writes. */
async function workDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "secret-cli-"));
	workDirs.push(dir);
	return dir;
}

/** A stream the command writes to, which keeps what it is given. */
class Output {
	text = "";

	constructor(readonly isTTY = false) {}

	write(text: string): void {
		this.text += text;
	}
}

/** How the progress line is rewritten: back to the line's start, then erased. */
const ERASE_LINE = "\r\u001b[K";

/** What a terminal shows of what was written to it: its lines, and the line under way. */
function screenOf(written: string): { lines: string[]; current: string } {
	const shown = written.split("\n").map((line) => {
		const erased = line.lastIndexOf(ERASE_LINE);
		return erased === -1 ? line : line.slice(erased + ERASE_LINE.length);
	});
	return { lines: shown.slice(0, -1), current: shown.at(-1) ?? "" };
}

/** What a run of the command line did. */
interface Outcome {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
	/** Its requests, as `METHOD /path`, with `[key]` or `[proof of work]` for a write's authentication. */
	readonly requests: ReadonlyArray<string>;
}

interface RunOptions {
	/** Piped in, not a terminal; nothing by default. */
	readonly stdin?: string;
	readonly env?: Record<string, string>;
	readonly cwd?: string;
	/** Ctrl-C, once aborted. */
	readonly signal?: AbortSignal;
	/** What the command gets of an answer, by its request as `requests` records it. */
	readonly answer?: (request: string, response: Response) => Response;
	/** The controlling terminal; none by default. */
	readonly terminal?: Terminal;
	/** Whether stderr is a terminal, where the progress shows; not by default. */
	readonly stderrIsTTY?: boolean;
}

/** A terminal on which the passwords are typed in turn, keeping its prompts and what it shows. */
function fakeTerminal(answers: ReadonlyArray<string>) {
	const left = [...answers];
	const terminal = {
		prompts: [] as string[],
		written: "",
		readHidden: async (prompt: string) => {
			terminal.prompts.push(prompt);
			const answer = left.shift();
			if (answer === undefined) {
				throw new Error("no password left to type");
			}
			return answer;
		},
		write: (text: string) => {
			terminal.written += text;
		},
		close: () => undefined,
	};
	return terminal;
}

const PATH_WORDS = new Set([
	"api",
	"v1",
	"config",
	"notes",
	"upload",
	"init",
	"chunks",
	"complete",
	"exists",
	"reads",
	"raw",
	"stream",
	"cap",
	"challenge",
	"redeem",
]);

/** A request's route, ids as `:id` and numbers as `:n`, then how it authenticated. */
function requestOf(input: RequestInfo | URL, init: RequestInit | undefined): string {
	const request = input instanceof Request ? input : undefined;
	const method = init?.method ?? request?.method ?? "GET";
	const url = new URL(request?.url ?? String(input));
	const path = url.pathname
		.split("/")
		.map((part) => {
			if (part === "" || PATH_WORDS.has(part)) return part;
			return /^\d+$/.test(part) ? ":n" : ":id";
		})
		.join("/");
	const headers = new Headers(init?.headers ?? request?.headers);
	if (headers.has("authorization")) return `${method} ${path} [key]`;
	if (headers.has("x-cap-token")) return `${method} ${path} [proof of work]`;
	return `${method} ${path}`;
}

/** Runs `secret <argv>` as a shell would, its every request recorded. */
async function secret(argv: ReadonlyArray<string>, options: RunOptions = {}): Promise<Outcome> {
	const stdout = new Output();
	const stderr = new Output(options.stderrIsTTY);
	const requests: string[] = [];
	const piped = options.stdin;
	const io: Io = {
		stdin: {
			isTTY: false,
			async *[Symbol.asyncIterator]() {
				if (piped !== undefined) {
					yield new TextEncoder().encode(piped);
				}
			},
		},
		stdout,
		stderr,
		env: options.env ?? {},
		cwd: options.cwd ?? (await workDir()),
		fetch: async (input, init) => {
			const request = requestOf(input, init);
			requests.push(request);
			const response = await fetch(input, init);
			return options.answer?.(request, response) ?? response;
		},
		signal: options.signal ?? new AbortController().signal,
		...(options.terminal === undefined ? {} : { openTerminal: () => options.terminal }),
	};
	const code = await run(argv, io);
	const outcome = { code, stdout: stdout.text, stderr: stderr.text, requests };
	outcomes.push(outcome);
	// A link printed is a key that must not show anywhere else.
	for (const [, key] of stdout.text.matchAll(/#(?:1\.)?([A-Za-z0-9_-]{43})/g)) {
		secrets.add(key as string);
	}
	return outcome;
}

/** The environment of a write: the instance, and the API key unless `env` says otherwise. */
function writer(env: Record<string, string> = {}): Record<string, string> {
	return { SECRET_INSTANCE: baseUrl, SECRET_API_KEY: API_KEY, ...env };
}

/** The link `send` printed: its stdout, one line and nothing else. */
function linkIn(outcome: Outcome): string {
	expect(outcome.code, outcome.stderr).toBe(0);
	const link = outcome.stdout.slice(0, -1);
	expect(outcome.stdout).toBe(`${link}\n`);
	expect(link.startsWith(`${baseUrl}/note/`)).toBe(true);
	return link;
}

/** Sends a note with the API key, and answers its link. */
async function send(args: ReadonlyArray<string>, options: RunOptions = {}): Promise<string> {
	return linkIn(await secret(["send", ...args], { ...options, env: writer(options.env) }));
}

/** What `check --json` says of a note. */
async function infoOf(link: string): Promise<Record<string, unknown>> {
	const checked = await secret(["check", link, "--json"]);
	return JSON.parse(checked.stdout) as Record<string, unknown>;
}

const FORMAT_1_LINK = /^http:\/\/127\.0\.0\.1:\d+\/note\/[A-Za-z0-9_-]{12}#1\.[A-Za-z0-9_-]{43}$/;
const FORMAT_0_LINK = /^http:\/\/127\.0\.0\.1:\d+\/note\/[A-Za-z0-9_-]{12}#[A-Za-z0-9_-]{43}$/;

describe("secret send and secret read, against the application", () => {
	it("sends the text piped in, and reads it back byte for byte", async () => {
		const text = "line one\n\ttabbed, ünïcödé, 🔒\r\nno line feed at the end";

		const sent = await secret(["send"], { stdin: text, env: writer() });
		const link = linkIn(sent);
		expect(link).toMatch(FORMAT_1_LINK);
		expect(sent.stderr).toMatch(/^Expires \S+, in 1d; it is deleted once read\.\n/);
		expect(sent.stderr).toContain("\nDelete token: ");
		expect(sent.requests).toEqual(["GET /api/v1/config", "POST /api/v1/notes [key]"]);

		const read = await secret(["read", link]);
		expect(read).toMatchObject({
			code: 0,
			stdout: text,
			stderr: "That was the note's last read: it is deleted.\n",
		});
		// The proofs are sent once: a read is never retried.
		expect(read.requests).toEqual([
			"GET /api/v1/notes/:id/exists",
			"GET /api/v1/notes/:id/exists",
			"POST /api/v1/notes/:id/reads",
		]);
	});

	it("sends files, and writes them where --out says, overwriting nothing", async () => {
		const from = await workDir();
		const to = await workDir();
		const report = randomBytes(20 * 1024);
		await writeFile(join(from, "report.pdf"), report);
		await writeFile(join(from, "empty.txt"), "");
		await mkdir(join(to, "inbox"));
		await writeFile(join(to, "inbox", "report.pdf"), "already here");

		const sent = await secret(["send", "report.pdf", "empty.txt"], {
			cwd: from,
			stdin: "two files",
			env: writer(),
		});
		// Small enough for one message, sent in one request.
		expect(sent.requests).toEqual(["GET /api/v1/config", "POST /api/v1/notes/upload [key]"]);

		const read = await secret(["read", linkIn(sent), "--out", "inbox"], { cwd: to });
		expect(read).toMatchObject({ code: 0, stdout: "two files" });
		const inbox = join(to, "inbox");
		expect((await readdir(inbox)).sort()).toEqual(["empty.txt", "report (1).pdf", "report.pdf"]);
		expect(await readFile(join(inbox, "report (1).pdf"))).toEqual(report);
		expect(await readFile(join(inbox, "empty.txt"))).toEqual(Buffer.alloc(0));
		expect(await readFile(join(inbox, "report.pdf"), "utf8")).toBe("already here");
		expect((await stat(join(inbox, "report (1).pdf"))).mode & 0o777).toBe(0o600);
		expect(read.stderr).toBe(
			[
				`Saved ${join(inbox, "report (1).pdf")} (20 KiB)`,
				`Saved ${join(inbox, "empty.txt")} (0 B)`,
				"That was the note's last read: it is deleted.",
				"",
			].join("\n"),
		);
	});

	it("sends a file larger than the instance's chunk size in a session, at that size", async () => {
		const from = await workDir();
		const to = await workDir();
		const big = randomBytes(3 * CHUNK_SIZE + 5);
		await writeFile(join(from, "big.bin"), big);

		const sent = await secret(["send", "big.bin"], { cwd: from, env: writer() });
		// The body padded to its size class (its head of a few dozen bytes
		// leaves it in the same one), cut at the chunk size the instance announces.
		const messages = Math.ceil(sizeClass(4 + big.length) / CHUNK_SIZE);
		expect(messages).toBe(4);
		expect(sent.requests).toEqual([
			"GET /api/v1/config",
			"POST /api/v1/notes/upload/init [key]",
			...Array.from({ length: messages }, () => "PUT /api/v1/notes/upload/:id/chunks/:n [key]"),
			"POST /api/v1/notes/upload/:id/complete [key]",
		]);

		// No --out: the files go to the current directory. Quiet: nothing told.
		const read = await secret(["read", linkIn(sent), "--quiet"], { cwd: to });
		expect(read).toMatchObject({ code: 0, stdout: "", stderr: "" });
		expect(await readdir(to)).toEqual(["big.bin"]);
		expect(await readFile(join(to, "big.bin"))).toEqual(big);
	});

	it(
		"sends a note behind a password, in format 1, and reads it with the password",
		async () => {
			const link = await send(["--password"], {
				stdin: "behind a password",
				env: { SECRET_PASSWORD: PASSWORD },
			});
			expect(link).toMatch(FORMAT_1_LINK);

			const checked = await secret(["check", link]);
			expect(checked.stdout).toContain("Password: yes, 5 wrong ones before the note is deleted\n");

			const read = await secret(["read", link], { env: { SECRET_PASSWORD: PASSWORD } });
			expect(read).toMatchObject({ code: 0, stdout: "behind a password" });
		},
		ARGON2_TIMEOUT,
	);

	it(
		"writes format 0 when asked, behind a password, a file larger than the chunk size in a session",
		async () => {
			const from = await workDir();
			const to = await workDir();
			const big = randomBytes(2 * CHUNK_SIZE + 3);
			await writeFile(join(from, "big.bin"), big);
			await writeFile(join(from, "password.txt"), `${PASSWORD}\nnot the password\n`);

			// A password file says the note has one: its first line.
			const sent = await secret(
				["send", "--format", "0", "--password-file", "password.txt", "--max-reads", "2", "big.bin"],
				{ cwd: from, stdin: "format 0", env: writer() },
			);
			const link = linkIn(sent);
			expect(link).toMatch(FORMAT_0_LINK);
			// The head, then the file in pieces of at most the chunk size.
			expect(sent.requests).toEqual([
				"GET /api/v1/config",
				"POST /api/v1/notes/upload/init [key]",
				...Array.from(
					{ length: 1 + Math.ceil(big.length / CHUNK_SIZE) },
					() => "PUT /api/v1/notes/upload/:id/chunks/:n [key]",
				),
				"POST /api/v1/notes/upload/:id/complete [key]",
			]);

			const checked = await secret(["check", link]);
			expect(checked.stdout).toContain("Password: yes\n");
			expect(checked.stdout).toContain("Format:   0\n");

			// Format 0 cannot check a password before the note is served.
			const wrong = await secret(["read", link, "--out", to], {
				env: { SECRET_PASSWORD: WRONG_PASSWORD },
			});
			expect(wrong).toMatchObject({
				code: 4,
				stdout: "",
				stderr:
					"secret: wrong password, or the link is wrong or damaged: the read is spent all the same, a note of format 0 cannot be checked first\n",
			});
			expect(await readdir(to)).toEqual([]);
			expect(await infoOf(link)).toMatchObject({ exists: true, readCount: 1 });

			const read = await secret(["read", link, "--out", to], {
				env: { SECRET_PASSWORD: PASSWORD },
			});
			expect(read).toMatchObject({ code: 0, stdout: "format 0" });
			expect(read.requests).toEqual([
				"GET /api/v1/notes/:id/exists",
				"GET /api/v1/notes/:id/stream",
			]);
			expect(await readFile(join(to, "big.bin"))).toEqual(big);
		},
		ARGON2_TIMEOUT * 2,
	);

	it("answers one JSON value with --json, and nothing on stderr", async () => {
		const from = await workDir();
		const to = await workDir();
		await writeFile(join(from, "notes.md"), "# Notes\n");

		// --instance, its trailing slash dropped, in place of SECRET_INSTANCE.
		const sent = await secret(
			[
				"send",
				"--instance",
				`${baseUrl}/`,
				"--json",
				"--max-reads",
				"2",
				"--expires",
				"1h",
				"--mode",
				"markdown",
				"notes.md",
			],
			{ cwd: from, stdin: "**bold**", env: { SECRET_API_KEY: API_KEY } },
		);
		expect(sent).toMatchObject({ code: 0, stderr: "" });
		expect(sent.stdout).toMatch(/^[^\n]+\n$/);
		const created = JSON.parse(sent.stdout) as Record<string, unknown>;
		expect(created).toEqual({
			link: expect.stringMatching(FORMAT_1_LINK),
			id: expect.stringMatching(/^[A-Za-z0-9_-]{12}$/),
			expiresAt: expect.any(String),
			deleteToken: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/),
			maxReads: 2,
		});
		const link = String(created["link"]);
		expect(link).toContain(`/note/${String(created["id"])}#`);
		const expiresIn = Date.parse(String(created["expiresAt"])) - Date.now();
		expect(expiresIn).toBeGreaterThan(3540_000);
		expect(expiresIn).toBeLessThanOrEqual(3600_000);

		const checked = await secret(["check", link, "--json"]);
		expect(checked).toMatchObject({ code: 0, stderr: "" });
		expect(JSON.parse(checked.stdout)).toMatchObject({
			exists: true,
			hasPassword: false,
			fileCount: 1,
			maxReads: 2,
			readCount: 0,
			expiresAt: created["expiresAt"],
		});

		const read = await secret(["read", link, "--json", "--out", to]);
		expect(read).toMatchObject({ code: 0, stderr: "" });
		expect(read.stdout).toMatch(/^[^\n]+\n$/);
		expect(JSON.parse(read.stdout)).toEqual({
			text: "**bold**",
			contentMode: "markdown",
			files: [{ name: "notes.md", path: join(to, "notes.md"), type: "text/markdown", size: 8 }],
			createdAt: expect.any(String),
			expiresAt: created["expiresAt"],
		});
		expect(await readFile(join(to, "notes.md"), "utf8")).toBe("# Notes\n");
		expect(await infoOf(link)).toMatchObject({ exists: true, readCount: 1 });
	});

	it("shows its progress on a terminal, and erases it before anything else", async () => {
		const from = await workDir();
		const to = await workDir();
		await writeFile(join(from, "big.bin"), randomBytes(3 * CHUNK_SIZE + 5));

		// Without a key: the proof of work shows its progress too.
		const sent = await secret(["send", "big.bin"], {
			cwd: from,
			env: { SECRET_INSTANCE: baseUrl },
			stderrIsTTY: true,
		});
		expect(sent.code, sent.stderr).toBe(0);
		expect(sent.stderr).toContain(`${ERASE_LINE}Proof of work 4/4`);
		expect(sent.stderr).toContain(`${ERASE_LINE}Uploading `);
		expect(screenOf(sent.stderr)).toEqual({
			lines: [
				expect.stringMatching(/^Expires \S+, in 1d; it is deleted once read\.$/),
				expect.stringMatching(/^Delete token: [A-Za-z0-9_-]{32}$/),
				expect.stringMatching(/^To delete it sooner: secret delete <link> --token \S{32}$/),
			],
			current: "",
		});
		const link = linkIn(sent);

		const read = await secret(["read", link, "--out", to], { stderrIsTTY: true });
		expect(read.code, read.stderr).toBe(0);
		expect(read.stderr).toContain(`${ERASE_LINE}Downloading `);
		expect(screenOf(read.stderr)).toEqual({
			lines: [
				`Saved ${join(to, "big.bin")} (192 KiB)`,
				"That was the note's last read: it is deleted.",
			],
			current: "",
		});

		const gone = await secret(["read", link], { stderrIsTTY: true });
		expect(screenOf(gone.stderr)).toEqual({ lines: [NOT_FOUND.slice(0, -1)], current: "" });
	});

	it("sends the longest text a note holds, and refuses a longer one before any request", async () => {
		// Three bytes of UTF-8 each: the largest note without files there is.
		const longest = "€".repeat(102_400);

		const link = await send([], { stdin: longest });
		const read = await secret(["read", link]);
		expect(read).toMatchObject({ code: 0, stdout: longest });

		const tooLong = await secret(["send"], { stdin: `${longest}€`, env: writer() });
		expect(tooLong).toMatchObject({
			code: 2,
			stdout: "",
			stderr:
				"secret: the text is longer than a note holds (102400 characters): send it as a file\n",
		});
		// The instance's limits only: nothing was encrypted, or sent.
		expect(tooLong.requests).toEqual(["GET /api/v1/config"]);
	});
});

describe("secret check and secret delete, against the application", () => {
	it("checks a note without spending its read, and finds it gone once read (code 3)", async () => {
		const link = await send([], { stdin: "read once" });

		for (let i = 0; i < 2; i++) {
			const checked = await secret(["check", link]);
			expect(checked).toMatchObject({ code: 0, stderr: "" });
			expect(checked.stdout).toMatch(
				/^Password: no\nFiles: {4}0\nExpires: {2}\S+\nReads: {4}1 left of 1\nFormat: {3}1\n$/,
			);
		}
		expect((await secret(["read", link])).code).toBe(0);

		expect(await secret(["check", link])).toMatchObject({
			code: 3,
			stdout: "",
			stderr: NOT_FOUND,
		});
		expect(await secret(["check", link, "--json"])).toMatchObject({
			code: 3,
			stdout: '{"exists":false}\n',
			stderr: NOT_FOUND,
		});
		expect(await secret(["read", link])).toMatchObject({ code: 3, stdout: "", stderr: NOT_FOUND });
	});

	it("reads a note of unlimited reads as often as asked", async () => {
		const link = await send(["--max-reads", "0"], { stdin: "again and again" });

		expect((await secret(["check", link])).stdout).toContain("Reads:    no limit\n");
		for (let i = 0; i < 3; i++) {
			expect(await secret(["read", link])).toMatchObject({
				code: 0,
				stdout: "again and again",
				stderr: "",
			});
		}
		expect(await infoOf(link)).toMatchObject({ exists: true, maxReads: 0 });
	});

	it("deletes a note with its delete token, and refuses a wrong one (code 4)", async () => {
		const sent = await secret(["send", "--json"], { stdin: "to delete", env: writer() });
		const { link, deleteToken } = JSON.parse(sent.stdout) as { link: string; deleteToken: string };

		const refused = await secret(["delete", link, "--token", "x".repeat(32)], { env: writer() });
		expect(refused).toMatchObject({ code: 4, stdout: "", stderr: "secret: wrong delete token\n" });
		expect(await infoOf(link)).toMatchObject({ exists: true, readCount: 0 });

		const deleted = await secret(["delete", link, "--token", deleteToken, "--json"], {
			env: writer(),
		});
		expect(deleted).toMatchObject({ code: 0, stdout: '{"deleted":true}\n', stderr: "" });
		expect(deleted.requests).toEqual([
			"GET /api/v1/notes/:id/exists [key]",
			"DELETE /api/v1/notes/:id [key]",
		]);
		expect(await secret(["check", link])).toMatchObject({ code: 3, stderr: NOT_FOUND });

		const again = await secret(["delete", link, "--token", deleteToken, "--json"], {
			env: writer(),
		});
		expect(again).toMatchObject({ code: 3, stdout: "", stderr: NOT_FOUND });
	});
});

describe("writing without an API key, against the application", () => {
	it("solves the instance's proof of work for each write", async () => {
		const sent = await secret(["send", "--json"], {
			stdin: "proved",
			env: { SECRET_INSTANCE: baseUrl },
		});
		expect(sent).toMatchObject({ code: 0, stderr: "" });
		expect(sent.requests).toEqual([
			"GET /api/v1/config",
			"POST /api/cap/challenge",
			"POST /api/cap/redeem",
			"POST /api/v1/notes [proof of work]",
		]);
		const { link, deleteToken } = JSON.parse(sent.stdout) as { link: string; deleteToken: string };
		expect(await infoOf(link)).toMatchObject({ exists: true });

		// A token is spent by one write: deleting the note takes another.
		const deleted = await secret(["delete", link, "--token", deleteToken], {
			env: { SECRET_INSTANCE: baseUrl },
		});
		expect(deleted).toMatchObject({ code: 0, stderr: "The note is deleted.\n" });
		expect(deleted.requests).toEqual([
			"GET /api/v1/notes/:id/exists",
			"POST /api/cap/challenge",
			"POST /api/cap/redeem",
			"DELETE /api/v1/notes/:id [proof of work]",
		]);
		expect(await infoOf(link)).toEqual({ exists: false });
	});

	it("does not fall back to the proof of work when the instance refuses the API key", async () => {
		const wrongKey = { SECRET_API_KEY: randomBytes(32).toString("base64url") };
		secrets.add(wrongKey.SECRET_API_KEY);

		const sent = await secret(["send"], { stdin: "refused", env: writer(wrongKey) });
		expect(sent).toMatchObject({
			code: 4,
			stdout: "",
			stderr: "secret: the instance refused the write: check SECRET_API_KEY\n",
		});
		expect(sent.requests).toEqual(["GET /api/v1/config", "POST /api/v1/notes [key]"]);

		const sentWith = await secret(["send", "--json"], { stdin: "kept", env: writer() });
		const { link, deleteToken } = JSON.parse(sentWith.stdout) as {
			link: string;
			deleteToken: string;
		};
		const deleted = await secret(["delete", link, "--token", deleteToken], {
			env: writer(wrongKey),
		});
		expect(deleted).toMatchObject({
			code: 4,
			stderr: "secret: the instance refused the write: check SECRET_API_KEY\n",
		});
		expect(deleted.requests).toEqual([
			"GET /api/v1/notes/:id/exists [key]",
			"DELETE /api/v1/notes/:id [key]",
		]);
		expect(await infoOf(link)).toMatchObject({ exists: true });
	});
});

describe("refusals, against the application", () => {
	it(
		"refuses a wrong password of a format 1 note, spending no read but an attempt",
		async () => {
			const from = await workDir();
			await writeFile(join(from, "attached.txt"), "attached");
			const link = await send(["--password", "attached.txt"], {
				cwd: from,
				stdin: "five tries",
				env: { SECRET_PASSWORD: PASSWORD },
			});
			const to = await workDir();

			// No password and no terminal to ask it on: refused before anything is spent.
			const without = await secret(["read", link, "--out", to]);
			expect(without).toMatchObject({
				code: 2,
				stdout: "",
				stderr:
					"secret: no terminal to ask the password on: set SECRET_PASSWORD, or pass --password-file\n",
			});
			expect(without.requests).toEqual(["GET /api/v1/notes/:id/exists"]);

			const wrong = await secret(["read", link, "--out", to], {
				env: { SECRET_PASSWORD: WRONG_PASSWORD },
			});
			expect(wrong).toMatchObject({ code: 4, stdout: "", stderr: WRONG_PASSWORD_OR_LINK });
			// Given ahead of time, a wrong password is not tried again.
			expect(wrong.requests).toEqual([
				"GET /api/v1/notes/:id/exists",
				"GET /api/v1/notes/:id/exists",
				"POST /api/v1/notes/:id/reads",
			]);
			expect(await readdir(to)).toEqual([]);
			expect(await infoOf(link)).toMatchObject({
				exists: true,
				readCount: 0,
				passwordAttemptsLeft: 4,
			});
			expect((await secret(["check", link])).stdout).toContain(
				"Password: yes, 4 wrong ones before the note is deleted\n",
			);

			// Typed on the terminal, a wrong password is asked again, with the
			// attempts the instance says are left.
			const terminal = fakeTerminal([WRONG_PASSWORD, PASSWORD]);
			const typed = await secret(["read", link, "--out", to], { terminal });
			expect(typed).toMatchObject({ code: 0, stdout: "five tries" });
			expect(terminal.prompts).toEqual(["Password: ", "Password: "]);
			expect(terminal.written).toBe("Wrong password: 3 attempts left.\n");
			expect(await readFile(join(to, "attached.txt"), "utf8")).toBe("attached");
			expect(await secret(["check", link])).toMatchObject({ code: 3 });
		},
		ARGON2_TIMEOUT * 2,
	);

	it(
		"warns before the last attempt on a terminal, and says the note is gone after it",
		async () => {
			const link = await send(["--password"], {
				stdin: "last attempts",
				env: { SECRET_PASSWORD: PASSWORD },
			});
			// Three wrong passwords tried already, as anyone holding the link can.
			const { id, keyFragment } = SecretClient.parseShareUrl(link);
			const linkKey = new Uint8Array(Buffer.from(keyFragment.slice(2), "base64url"));
			const linkProof = Buffer.from(deriveFormat1Keys(linkKey).linkProof).toString("base64");
			for (let i = 0; i < 3; i++) {
				const res = await fetch(`${baseUrl}/api/v1/notes/${id}/reads`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ linkProof, passwordProof: randomBytes(32).toString("base64") }),
				});
				expect(res.status).toBe(403);
			}
			expect(await infoOf(link)).toMatchObject({ passwordAttemptsLeft: 2 });

			const terminal = fakeTerminal([WRONG_PASSWORD, WRONG_PASSWORD]);
			const typed = await secret(["read", link], { terminal });
			expect(typed).toMatchObject({
				code: 4,
				stdout: "",
				stderr: "secret: wrong password: that was the last attempt, the note is deleted\n",
			});
			expect(terminal.prompts).toEqual(["Password: ", "Password: "]);
			expect(terminal.written).toBe(
				"Wrong password: 1 attempt left.\nThe note takes one more wrong password: the next one deletes it.\n",
			);
			expect(await infoOf(link)).toEqual({ exists: false });
		},
		ARGON2_TIMEOUT * 2,
	);

	it("keeps the files a sender names inside --out, under names that hide nothing", async () => {
		const client = await SecretClient.create({ baseUrl, apiKey: API_KEY });
		const file = (name: string) => ({
			name,
			type: "text/plain",
			data: new TextEncoder().encode(name),
		});
		const names = [
			"../outside.txt",
			".bashrc",
			"a/b\\c.txt",
			"con.txt",
			"-rf",
			"same.txt",
			"same.txt",
		];
		const { id, keyFragment } = await client.createNote({ files: names.map(file) });
		secrets.add(keyFragment.slice(2));
		const to = await workDir();
		await mkdir(join(to, "out"));

		const read = await secret(["read", client.buildShareUrl(id, keyFragment), "--out", "out"], {
			cwd: to,
		});
		expect(read.code, read.stderr).toBe(0);

		expect(await readdir(to)).toEqual(["out"]);
		const written = Object.fromEntries(
			await Promise.all(
				(await readdir(join(to, "out"))).map(async (name) => [
					name,
					await readFile(join(to, "out", name), "utf8"),
				]),
			),
		);
		expect(written).toEqual({
			"outside.txt": "../outside.txt",
			bashrc: ".bashrc",
			"c.txt": "a/b\\c.txt",
			"_con.txt": "con.txt",
			rf: "-rf",
			"same.txt": "same.txt",
			"same (1).txt": "same.txt",
		});
	});

	it("refuses a format 0 link whose key cannot be one before the read is spent", async () => {
		// Read once: a read spent for nothing would burn it.
		const sent = await secret(["send", "--format", "0", "--json"], {
			stdin: "read once",
			env: writer(),
		});
		const { link, id, deleteToken } = JSON.parse(sent.stdout) as {
			link: string;
			id: string;
			deleteToken: string;
		};
		expect(link).toMatch(FORMAT_0_LINK);
		secrets.add(deleteToken);
		const [base, key] = link.split("#") as [string, string];
		// The next character sets a bit of the two the last one of a key leaves at zero.
		const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
		const strayed = `${key.slice(0, -1)}${BASE64URL[BASE64URL.indexOf(key.slice(-1)) + 1]}`;

		const malformed = {
			"a key cut short": link.slice(0, -1),
			"a key a character too long": `${link}A`,
			"a key whose last character carries stray bits": `${base}#${strayed}`,
			// Where a note's link holds the key, its management link holds the delete token.
			"the management link": `${baseUrl}/note/${id}/manage#${deleteToken}`,
		};
		for (const [why, argv] of Object.entries(malformed)) {
			const refused = await secret(["read", argv]);
			// As a malformed format 1 link is: refused before the note is read.
			expect(refused.code, why).not.toBe(0);
			expect(refused.stdout, why).toBe("");
			const spending = refused.requests.filter((r) => r !== "GET /api/v1/notes/:id/exists");
			expect(spending, why).toEqual([]);
		}
		expect(await infoOf(link)).toMatchObject({ exists: true, readCount: 0 });

		expect(await secret(["read", link])).toMatchObject({ code: 0, stdout: "read once" });
	});

	it("refuses a directory the files cannot go to before the read is spent", async () => {
		const from = await workDir();
		await writeFile(join(from, "a.txt"), "a");
		await writeFile(join(from, "not-a-directory"), "");
		const link = await send(["a.txt"], { cwd: from });

		const missing = await secret(["read", link, "--out", "missing"], { cwd: from });
		expect(missing).toMatchObject({
			code: 2,
			stdout: "",
			stderr: "secret: cannot write the note's files to missing (ENOENT)\n",
		});
		const file = await secret(["read", link, "--out", "not-a-directory"], { cwd: from });
		expect(file).toMatchObject({
			code: 2,
			stderr: "secret: cannot write the note's files to not-a-directory: not a directory\n",
		});
		expect(file.requests).toEqual(["GET /api/v1/notes/:id/exists"]);
		expect(await infoOf(link)).toMatchObject({ exists: true, readCount: 0 });
	});

	it("removes the partial file of a read interrupted by Ctrl-C (code 130)", async () => {
		const from = await workDir();
		const to = await workDir();
		await writeFile(join(from, "big.bin"), randomBytes(3 * CHUNK_SIZE + 5));
		const link = await send(["big.bin"], { cwd: from });
		const partFiles = async () => (await readdir(to)).filter((name) => name.endsWith(".part"));

		// Ctrl-C once the first message is in, and the file it starts is being written.
		const ctrlC = new AbortController();
		const firstMessage = 4 + CHUNK_SIZE + 17;
		const interruptOnceWriting = (request: string, response: Response): Response => {
			if (request !== "POST /api/v1/notes/:id/reads" || response.body === null) {
				return response;
			}
			let passed = 0;
			const body = response.body.pipeThrough(
				new TransformStream<Uint8Array, Uint8Array>({
					async transform(chunk, controller) {
						controller.enqueue(chunk);
						passed += chunk.byteLength;
						if (passed > firstMessage && !ctrlC.signal.aborted) {
							await vi.waitFor(async () => expect(await partFiles()).toEqual(["big.bin.part"]));
							ctrlC.abort();
						}
					},
				}),
			);
			return new Response(body, { status: response.status, headers: response.headers });
		};

		const interrupted = await secret(["read", link, "--out", to], {
			signal: ctrlC.signal,
			answer: interruptOnceWriting,
		});
		expect(ctrlC.signal.aborted).toBe(true);
		expect(interrupted).toMatchObject({ code: 130, stdout: "", stderr: "secret: interrupted\n" });
		expect(await readdir(to)).toEqual([]);
	});

	it("never shows the link on stderr, whatever fails", async () => {
		const link = await send([], { stdin: "kept", env: {} });
		const [base, fragment] = link.split("#") as [string, string];
		const anotherKey = `1.${randomBytes(32).toString("base64url")}`;
		secrets.add(anotherKey.slice(2));

		const failures = [
			{
				why: "another key, whose link proof the instance refuses, counting nothing",
				argv: ["read", `${base}#${anotherKey}`],
				code: 4,
				stderr: WRONG_PASSWORD_OR_LINK,
			},
			{
				why: "the key without its format: format 0's reads refuse a format 1 note",
				argv: ["read", `${base}#${fragment.slice(2)}`],
				code: 4,
				stderr: "secret: the link does not fit the note: it is wrong or damaged\n",
			},
			{
				why: "a key cut short",
				argv: ["read", `${base}#1.cut-short`],
				code: 2,
				stderr: "secret: invalid key fragment\n",
			},
			{
				why: "an argument after the link",
				argv: ["read", link, "again"],
				code: 2,
				stderr: "secret: give one link: secret read <link>\n",
			},
			{
				why: "no delete token",
				argv: ["delete", link],
				code: 2,
				stderr:
					"secret: give the note's delete token: secret delete <link> --token <deleteToken>\n",
			},
			{
				why: "the link where the command goes",
				argv: [link],
				code: 2,
				stderr: "secret: unknown command: see secret --help\n",
			},
			{
				why: "the link where a file goes",
				argv: ["send", link],
				code: 2,
				stderr:
					"secret: argument 1 names no file: the text of a note goes on stdin, as in secret send < note.txt\n",
			},
			{
				why: "an instance that does not answer",
				argv: ["read", link.replace(baseUrl, "http://127.0.0.1:9")],
				code: 1,
				stderr: "secret: could not reach http://127.0.0.1:9\n",
			},
			{
				why: "a path where no instance is",
				argv: ["check", link.replace(baseUrl, `${baseUrl}/elsewhere`)],
				// No such endpoint there: not the note's 404, which has its own code.
				code: 1,
				stderr: `secret: ${baseUrl} refused the request (HTTP 404, not_found)\n`,
			},
			{
				why: "the link where the instance goes",
				argv: ["send", "--instance", link],
				code: 1,
				stderr: `secret: ${baseUrl} gave no limits (HTTP 404): is it a Secret instance?\n`,
			},
		];
		for (const { why, argv, code, stderr } of failures) {
			const outcome = await secret(argv, { env: writer() });
			expect(outcome, why).toMatchObject({ code, stdout: "", stderr });
			expect(outcome.stderr, why).not.toContain(fragment.slice(2));
		}
		expect(await infoOf(link)).toMatchObject({ exists: true, readCount: 0 });
	});
});

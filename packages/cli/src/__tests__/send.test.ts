import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretApiError } from "@largerio/secret-sdk";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT } from "../errors.js";
import { denied } from "./deniedAccess.js";
import {
	CAP_TOKEN,
	DELETE_TOKEN,
	EXPIRES_AT,
	fakeTerminal,
	harness,
	input,
	instanceFetch,
	KEY,
	LIMITS,
	LINK,
	NOTE_ID,
	ORIGIN,
	type Setup,
} from "./harness.js";

vi.mock("node:fs/promises", async (importOriginal) =>
	(await import("./deniedAccess.js")).withDeniedAccess(importOriginal),
);

const dir = mkdtempSync(join(tmpdir(), "secret-cli-send-"));
writeFileSync(join(dir, "report.pdf"), "%PDF-1.7");
writeFileSync(join(dir, "notes.txt"), "some notes");
writeFileSync(join(dir, "big.bin"), new Uint8Array(LIMITS.maxChunkedFileSize));
mkdirSync(join(dir, "folder"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

beforeEach(() => denied.clear());

function sending(setup: Setup = {}) {
	return harness({
		cwd: dir,
		stdin: input(["the launch code is 0000"]),
		...setup,
		env: { SECRET_INSTANCE: ORIGIN, ...setup.env },
	});
}

describe("secret send", () => {
	it("sends the text on stdin and prints the link alone on stdout", async () => {
		const { run, stdout, stderr, client, configs, fetch, pow } = sending();
		expect(await run("send")).toBe(EXIT.ok);

		expect(stdout.text).toBe(`${LINK}\n`);
		expect(stderr.text).toBe(
			[
				`Expires ${EXPIRES_AT}, in 1d; it is deleted once read.`,
				`Delete token: ${DELETE_TOKEN}`,
				`To delete it sooner: secret delete ${ORIGIN}/note/${NOTE_ID} --token=${DELETE_TOKEN}`,
				"",
			].join("\n"),
		);
		expect(stderr.text).not.toContain(KEY);

		expect(fetch).toHaveBeenCalledWith(`${ORIGIN}/api/v1/config`, expect.anything());
		expect(configs).toEqual([{ baseUrl: ORIGIN, fetch }]);
		expect(pow).toHaveBeenCalledOnce();
		expect(client.createNote).toHaveBeenCalledWith({
			text: "the launch code is 0000",
			capToken: CAP_TOKEN,
			maxReads: 1,
			expiresIn: 86_400,
			chunkSize: LIMITS.chunkSize,
			signal: expect.any(AbortSignal),
			onProgress: expect.any(Function),
		});
	});

	it("writes with the API key, without a proof of work", async () => {
		const { run, client, configs, pow } = sending({ env: { SECRET_API_KEY: "the-key" } });
		expect(await run("send")).toBe(EXIT.ok);
		expect(configs[0]).toMatchObject({ apiKey: "the-key" });
		expect(pow).not.toHaveBeenCalled();
		expect(client.createNote.mock.calls[0]?.[0]).not.toHaveProperty("capToken");
	});

	it("takes --instance over SECRET_INSTANCE", async () => {
		const { run, configs, fetch } = sending();
		expect(await run("send", "--instance", "https://other.example/secret/")).toBe(EXIT.ok);
		expect(fetch).toHaveBeenCalledWith(
			"https://other.example/secret/api/v1/config",
			expect.anything(),
		);
		expect(configs[0]).toMatchObject({ baseUrl: "https://other.example/secret" });
	});

	it("needs an instance", async () => {
		const { run, stderr, io } = harness({ stdin: input(["text"]), env: { SECRET_INSTANCE: " " } });
		expect(await run("send")).toBe(EXIT.usage);
		expect(stderr.text).toBe(
			"secret: no instance to send the note to: pass --instance <url>, or set SECRET_INSTANCE\n",
		);
		expect(io.fetch).not.toHaveBeenCalled();
	});

	it("prints one JSON value with --json, and nothing on stderr", async () => {
		const { run, stdout, stderr } = sending();
		expect(await run("send", "--json", "--max-reads", "3")).toBe(EXIT.ok);
		expect(JSON.parse(stdout.text)).toEqual({
			link: LINK,
			id: NOTE_ID,
			expiresAt: EXPIRES_AT,
			deleteToken: DELETE_TOKEN,
			maxReads: 3,
		});
		expect(stderr.text).toBe("");
	});

	it("prints the link alone with --quiet", async () => {
		const { run, stdout, stderr } = sending({ stderrIsTTY: true });
		expect(await run("send", "-q")).toBe(EXIT.ok);
		expect(stdout.text).toBe(`${LINK}\n`);
		expect(stderr.text).toBe("");
	});

	it("passes on the note's settings", async () => {
		const { run, client, stderr } = sending();
		expect(
			await run("send", "--max-reads", "0", "--expires", "1h", "--mode", "secret", "--format", "0"),
		).toBe(EXIT.ok);
		expect(client.createNote).toHaveBeenCalledWith(
			expect.objectContaining({ maxReads: 0, expiresIn: 3600, contentMode: "secret", format: 0 }),
		);
		expect(stderr.text).toContain(
			`Expires ${EXPIRES_AT}, in 1h; it can be read any number of times until then.`,
		);

		const several = sending();
		await several.run("send", "--max-reads", "5", "--format", "1");
		expect(several.client.createNote).toHaveBeenCalledWith(expect.objectContaining({ format: 1 }));
		expect(several.stderr.text).toContain("it is deleted after 5 reads.");
	});

	it.each([
		[["--format", "2"], "--format takes 0, 1"],
		[["--mode", "html"], "--mode takes text, markdown, secret"],
		[["--expires", "1y"], "--expires takes a duration: 30m, 1h, 7d, 2w, or seconds"],
		[["--expires", "60"], "--expires takes a duration from 5m to 30d"],
		[["--max-reads", "1001"], "--max-reads takes a whole number from 0 to 1000"],
		[["--api-key", "secret"], "unknown option '--api-key': see secret send --help"],
		[["--instance", "secret.example"], "the instance must be an http or https URL"],
	])("refuses %j", async (args, message) => {
		const { run, stderr, io } = sending();
		expect(await run("send", ...args)).toBe(EXIT.usage);
		expect(stderr.text).toBe(`secret: ${message}\n`);
		expect(io.fetch).not.toHaveBeenCalled();
	});

	it("refuses an expiry the instance does not keep, and lowers the default to its own", async () => {
		const limits = { ...LIMITS, maxExpiry: 3600 };
		const refused = sending({ fetch: instanceFetch(limits) });
		expect(await refused.run("send", "--expires", "7d")).toBe(EXIT.usage);
		expect(refused.stderr.text).toBe(
			`secret: ${ORIGIN} keeps a note at most 1h: ask for less with --expires\n`,
		);
		expect(refused.client.createNote).not.toHaveBeenCalled();

		const lowered = sending({ fetch: instanceFetch(limits) });
		expect(await lowered.run("send")).toBe(EXIT.ok);
		expect(lowered.client.createNote).toHaveBeenCalledWith(
			expect.objectContaining({ expiresIn: 3600 }),
		);
	});

	it("refuses an instance that gives no limits, before reading anything", async () => {
		const { run, stderr, client } = sending({
			fetch: vi.fn(async () => new Response("<html>", { status: 502 })),
		});
		expect(await run("send")).toBe(EXIT.failure);
		expect(stderr.text).toBe(
			`secret: ${ORIGIN} gave no limits (HTTP 502): is it a Secret instance?\n`,
		);
		expect(client.createNote).not.toHaveBeenCalled();
	});

	it("needs something to send", async () => {
		const { run, stderr } = sending({ stdin: input([]) });
		expect(await run("send")).toBe(EXIT.usage);
		expect(stderr.text).toBe(
			"secret: nothing to send: pipe the text on stdin, or name the files\n",
		);
	});

	it("asks for the text on a terminal when no file is named", async () => {
		const { run, stderr, client } = sending({ stdin: input(["typed\n"], true) });
		expect(await run("send", "-q")).toBe(EXIT.ok);
		expect(stderr.text).toBe("Type the secret, then press Ctrl-D:\n");
		expect(client.createNote).toHaveBeenCalledWith(expect.objectContaining({ text: "typed\n" }));
	});

	it("refuses a text longer than a note holds", async () => {
		const { run, stderr, client } = sending({ stdin: input(["a".repeat(102_401)]) });
		expect(await run("send")).toBe(EXIT.usage);
		expect(stderr.text).toContain("the text is longer than a note holds");
		expect(client.createNote).not.toHaveBeenCalled();
	});

	describe("files", () => {
		it("sends each file as a Blob, by its name and type, with the text on stdin", async () => {
			const { run, client } = sending();
			expect(await run("send", "report.pdf", join(dir, "notes.txt"))).toBe(EXIT.ok);
			const options = client.createNote.mock.calls[0]?.[0];
			expect(options?.text).toBe("the launch code is 0000");
			expect(options?.files?.map(({ name, type }) => ({ name, type }))).toEqual([
				{ name: "report.pdf", type: "application/pdf" },
				{ name: "notes.txt", type: "text/plain" },
			]);
			const pdf = options?.files?.[0]?.data;
			expect(pdf).toBeInstanceOf(Blob);
			expect(await (pdf as Blob).text()).toBe("%PDF-1.7");
		});

		it("sends files alone when stdin is a terminal, without asking for a text", async () => {
			const stdin = input(["never read"], true);
			const { run, client, stderr } = sending({ stdin });
			expect(await run("send", "-q", "notes.txt")).toBe(EXIT.ok);
			expect(stderr.text).toBe("");
			expect(client.createNote.mock.calls[0]?.[0]).not.toHaveProperty("text");
		});

		it("sends files alone when stdin is empty", async () => {
			const { run, client } = sending({ stdin: input([]) });
			expect(await run("send", "notes.txt")).toBe(EXIT.ok);
			expect(client.createNote.mock.calls[0]?.[0]).not.toHaveProperty("text");
		});

		it("refuses a path that names no file, without repeating it", async () => {
			const { run, stderr, io } = sending();
			expect(await run("send", "notes.txt", "my secret password")).toBe(EXIT.usage);
			expect(stderr.text).toBe(
				"secret: argument 2 names no file: the text of a note goes on stdin, as in secret send < note.txt\n",
			);
			expect(io.fetch).not.toHaveBeenCalled();

			const under = sending();
			expect(await under.run("send", "notes.txt/inner")).toBe(EXIT.usage);
			expect(under.stderr.text).toContain("argument 1 names no file");
		});

		it.each([
			[["folder"], "folder is a directory: send an archive of it"],
			[["/dev/null"], "/dev/null is not a regular file"],
			[["bad\u0000path"], "cannot read bad\u0000path: ERR_INVALID_ARG_VALUE"],
		])("refuses %j", async (args, message) => {
			const { run, stderr } = sending();
			expect(await run("send", ...args)).toBe(EXIT.usage);
			expect(stderr.text).toBe(`secret: ${message}\n`);
		});

		it("refuses a file it may not read", async () => {
			denied.add(join(dir, "notes.txt"));
			const { run, stderr } = sending();
			expect(await run("send", "notes.txt")).toBe(EXIT.usage);
			expect(stderr.text).toBe("secret: cannot read notes.txt: permission denied\n");
		});

		it("refuses more files than the instance takes", async () => {
			const { run, stderr } = sending({ fetch: instanceFetch({ ...LIMITS, maxFilesPerNote: 1 }) });
			expect(await run("send", "notes.txt", "report.pdf")).toBe(EXIT.usage);
			expect(stderr.text).toBe(`secret: ${ORIGIN} takes at most 1 files in a note\n`);
		});

		it("refuses files larger than the instance takes", async () => {
			const { run, stderr } = sending();
			expect(await run("send", "big.bin", "notes.txt")).toBe(EXIT.usage);
			expect(stderr.text).toBe(
				`secret: the files take 1.0 MiB, and ${ORIGIN} takes at most 1.0 MiB in a note\n`,
			);
		});
	});

	describe("password", () => {
		it("takes SECRET_PASSWORD", async () => {
			const { run, client, openTerminal } = sending({ env: { SECRET_PASSWORD: "hunter2" } });
			expect(await run("send", "--password")).toBe(EXIT.ok);
			expect(client.createNote).toHaveBeenCalledWith(
				expect.objectContaining({ password: "hunter2" }),
			);
			expect(openTerminal).not.toHaveBeenCalled();
		});

		it("takes --password-file, which says the note has one", async () => {
			writeFileSync(join(dir, "password"), "from-file\n");
			const { run, client } = sending();
			expect(await run("send", "--password-file", "password")).toBe(EXIT.ok);
			expect(client.createNote).toHaveBeenCalledWith(
				expect.objectContaining({ password: "from-file" }),
			);
		});

		it("asks twice on the terminal", async () => {
			const terminal = fakeTerminal(["hunter2", "hunter2"]);
			const { run, client } = sending({ terminal });
			expect(await run("send", "--password")).toBe(EXIT.ok);
			expect(client.createNote).toHaveBeenCalledWith(
				expect.objectContaining({ password: "hunter2" }),
			);
			expect(terminal.close).toHaveBeenCalledOnce();
		});

		it("needs a source", async () => {
			const { run, stderr, client } = sending();
			expect(await run("send", "--password")).toBe(EXIT.usage);
			expect(stderr.text).toBe(
				"secret: no terminal to ask the password on: set SECRET_PASSWORD, or pass --password-file\n",
			);
			expect(client.createNote).not.toHaveBeenCalled();
		});

		it("sends no password unless asked to", async () => {
			const { run, client } = sending({ env: { SECRET_PASSWORD: "hunter2" } });
			expect(await run("send")).toBe(EXIT.ok);
			expect(client.createNote.mock.calls[0]?.[0]).not.toHaveProperty("password");
		});
	});

	it("shows its progress on a terminal, then erases it", async () => {
		const { run, client, stderr } = sending({ stderrIsTTY: true });
		client.createNote.mockImplementation(async (options) => {
			options.onProgress?.({ phase: "encrypting", phaseProgress: 0, overallProgress: 0 });
			options.onProgress?.({ phase: "uploading", phaseProgress: 1, overallProgress: 1 });
			return { id: NOTE_ID, expiresAt: EXPIRES_AT, deleteToken: DELETE_TOKEN, keyFragment: KEY };
		});
		expect(await run("send")).toBe(EXIT.ok);
		const erase = "\r\u001b[K";
		expect(
			stderr.text.startsWith(
				[
					`${erase}Proof of work 1/2`,
					`${erase}Proof of work 2/2`,
					erase,
					`${erase}Encrypting 0%`,
					`${erase}Uploading 100%`,
					`${erase}Expires `,
				].join(""),
			),
		).toBe(true);
	});

	it.each([
		[
			"a refused proof of work",
			{},
			new SecretApiError("Unauthorized", 401, { code: "unauthorized" }),
			"the instance refused the write: set SECRET_API_KEY, or check it",
			EXIT.refused,
		],
		[
			"a refused key",
			{ SECRET_API_KEY: "wrong" },
			new SecretApiError("Unauthorized", 401, { code: "unauthorized" }),
			"the instance refused the write: check SECRET_API_KEY",
			EXIT.refused,
		],
		[
			"an instance older than format 1",
			{},
			new SecretApiError("Validation failed", 400),
			`${ORIGIN} refused the note: an instance older than 1.6.0 takes --format 0 only`,
			EXIT.failure,
		],
		[
			"a missing endpoint",
			{},
			new SecretApiError("HTTP 404", 404),
			`${ORIGIN} refused the request (HTTP 404)`,
			EXIT.failure,
		],
	])("reports %s, never the link", async (_name, env, err, message, exitCode) => {
		const { run, client, stderr, stdout } = sending({ env });
		client.createNote.mockRejectedValue(err);
		expect(await run("send")).toBe(exitCode);
		expect(stderr.text).toBe(`secret: ${message}\n`);
		expect(stdout.text).toBe("");
	});

	it("stops at Ctrl-C", async () => {
		const controller = new AbortController();
		const { run, client, stderr, stdout } = sending({ signal: controller.signal });
		client.createNote.mockImplementation(async () => {
			controller.abort();
			throw controller.signal.reason;
		});
		expect(await run("send")).toBe(EXIT.interrupted);
		expect(stderr.text).toBe("secret: interrupted\n");
		expect(stdout.text).toBe("");
	});
});

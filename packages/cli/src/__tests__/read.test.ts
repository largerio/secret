import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ReadNoteIntoOptions,
	SecretApiError,
	SecretDecryptionError,
} from "@largerio/secret-sdk";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CliError, EXIT } from "../errors.js";
import { run as runCli } from "../run.js";
import { denied } from "./deniedAccess.js";
import {
	CREATED_AT,
	EXPIRES_AT,
	existingNote,
	fakeDirectory,
	fakeTerminal,
	harness,
	input,
	KEY,
	LINK,
	NOTE_ID,
	ORIGIN,
	type Setup,
	without,
} from "./harness.js";

vi.mock("node:fs/promises", async (importOriginal) =>
	(await import("./deniedAccess.js")).withDeniedAccess(importOriginal),
);

// The output directory by default, when the io gives none.
const files = vi.hoisted(() => ({ createOutputDirectory: vi.fn() }));
vi.mock("../files.js", () => files);

const cwd = mkdtempSync(join(tmpdir(), "secret-cli-read-"));
mkdirSync(join(cwd, "out"));
writeFileSync(join(cwd, "a-file"), "");
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

beforeEach(() => denied.clear());

const PASSWORD_NOTE = existingNote({ hasPassword: true, passwordAttemptsLeft: 5 });
const UNCOUNTED_PASSWORD_NOTE = without(PASSWORD_NOTE, "passwordAttemptsLeft");
const FORMAT_0_NOTE = without(existingNote(), "envelope");
const FORMAT_0_LINK = `${ORIGIN}/note/${NOTE_ID}#${"K".repeat(42)}A`;

function reading(setup: Setup = {}) {
	return harness({ cwd, ...setup });
}

/** A read that writes these files through the command's `openFile`, then answers. */
function readWithFiles(contents: Record<string, string>, text?: string) {
	return async (_id: string, _key: string, options: ReadNoteIntoOptions) => {
		const written = [];
		for (const [index, [name, content]] of Object.entries(contents).entries()) {
			const file = { name, type: "text/plain", size: content.length };
			const writer = (await options.openFile(file, index)).getWriter();
			await writer.write(new TextEncoder().encode(content));
			await writer.close();
			written.push(file);
		}
		return {
			...(text === undefined ? {} : { text }),
			files: written,
			createdAt: CREATED_AT,
			expiresAt: EXPIRES_AT,
			fileCount: written.length,
		};
	};
}

describe("secret read", () => {
	it("checks the note, then prints its text exactly", async () => {
		const { run, stdout, stderr, client, configs } = reading();
		client.readNoteInto.mockResolvedValue({
			text: "no line feed \u001b[2J",
			files: [],
			createdAt: CREATED_AT,
			expiresAt: EXPIRES_AT,
			fileCount: 0,
		});
		expect(await run("read", LINK)).toBe(EXIT.ok);
		expect(stdout.text).toBe("no line feed \u001b[2J");
		expect(stderr.text).toBe("That was the note's last read: it is deleted.\n");

		expect(configs).toEqual([{ baseUrl: ORIGIN, fetch: expect.any(Function) }]);
		expect(client.checkNote).toHaveBeenCalledWith(NOTE_ID, { signal: expect.any(AbortSignal) });
		expect(client.readNoteInto).toHaveBeenCalledWith(NOTE_ID, KEY, {
			chunked: false,
			openFile: expect.any(Function),
			signal: expect.any(AbortSignal),
			onProgress: expect.any(Function),
		});
		expect(client.checkNote.mock.invocationCallOrder[0]).toBeLessThan(
			client.readNoteInto.mock.invocationCallOrder[0] ?? 0,
		);
	});

	it("makes the text safe on a terminal, and ends its line", async () => {
		const { run, stdout, client } = reading({ stdoutIsTTY: true });
		client.readNoteInto.mockResolvedValue({
			text: "\u001b]0;owned\u0007text",
			files: [],
			createdAt: CREATED_AT,
			expiresAt: EXPIRES_AT,
			fileCount: 0,
		});
		expect(await run("read", LINK)).toBe(EXIT.ok);
		expect(stdout.text).toBe("␛]0;owned␇text\n");
	});

	it("tells when the note is gone", async () => {
		const { run, stderr, client } = reading();
		client.checkNote.mockResolvedValue({ exists: false });
		expect(await run("read", LINK)).toBe(EXIT.notFound);
		expect(stderr.text).toBe(
			"secret: this note does not exist: it expired, was already read, or never existed\n",
		);
		expect(client.readNoteInto).not.toHaveBeenCalled();
	});

	it.each([
		["no limit", 0, 0, false],
		["reads left", 3, 1, false],
		["the last read", 3, 2, true],
		["one read, the count unknown", 1, null, true],
		["reads, the count unknown", 3, null, false],
	])("tells whether this was the last read: %s", async (_name, maxReads, readCount, last) => {
		const { run, stderr, client } = reading();
		const uncounted = without(existingNote({ maxReads }), "readCount");
		client.checkNote.mockResolvedValue(
			readCount === null ? uncounted : { ...uncounted, readCount },
		);
		expect(await run("read", LINK)).toBe(EXIT.ok);
		expect(stderr.text.includes("last read")).toBe(last);
	});

	describe("files", () => {
		it("writes them in the current directory, and tells where", async () => {
			const { run, stdout, stderr, client, directories } = reading();
			client.checkNote.mockResolvedValue(existingNote({ fileCount: 2, maxReads: 2 }));
			client.readNoteInto.mockImplementation(readWithFiles({ "a.txt": "one", "b.txt": "two" }));
			expect(await run("read", LINK)).toBe(EXIT.ok);
			expect(stdout.text).toBe("");
			expect(stderr.text).toBe(`Saved ${cwd}/a.txt (3 B)\nSaved ${cwd}/b.txt (3 B)\n`);
			expect(directories[0]?.contents.get(`${cwd}/b.txt`)).toBe("two");
		});

		it("writes them where --out says", async () => {
			const { run, client, directories } = reading();
			client.checkNote.mockResolvedValue(existingNote({ fileCount: 1 }));
			client.readNoteInto.mockImplementation(readWithFiles({ "a.txt": "one" }, "text"));
			expect(await run("read", LINK, "--out", "out")).toBe(EXIT.ok);
			expect(directories[0]?.written.map(({ path }) => path)).toEqual([`${cwd}/out/a.txt`]);
		});

		it("prints the files with --json, the name as sent", async () => {
			const { run, stdout, stderr, client } = reading();
			client.checkNote.mockResolvedValue(existingNote({ fileCount: 1 }));
			client.readNoteInto.mockImplementation(readWithFiles({ "\u001b.txt": "one" }, "text"));
			expect(await run("read", LINK, "--json")).toBe(EXIT.ok);
			expect(JSON.parse(stdout.text)).toEqual({
				text: "text",
				files: [{ name: "\u001b.txt", path: `${cwd}/\u001b.txt`, type: "text/plain", size: 3 }],
				createdAt: CREATED_AT,
				expiresAt: EXPIRES_AT,
			});
			expect(stderr.text).toBe("");
		});

		it("prints the text with --json, its mode too", async () => {
			const { run, stdout, client } = reading();
			client.readNoteInto.mockResolvedValue({
				text: "hunter2",
				contentMode: "secret",
				files: [],
				createdAt: CREATED_AT,
				expiresAt: EXPIRES_AT,
				fileCount: 0,
			});
			expect(await run("read", LINK, "--json")).toBe(EXIT.ok);
			expect(JSON.parse(stdout.text)).toEqual({
				text: "hunter2",
				contentMode: "secret",
				files: [],
				createdAt: CREATED_AT,
				expiresAt: EXPIRES_AT,
			});
		});

		it("tells nothing with --quiet", async () => {
			const { run, stderr, client } = reading();
			client.checkNote.mockResolvedValue(existingNote({ fileCount: 1 }));
			client.readNoteInto.mockImplementation(readWithFiles({ "a.txt": "one" }));
			expect(await run("read", LINK, "-q")).toBe(EXIT.ok);
			expect(stderr.text).toBe("");
		});

		it.each([
			[
				["--out", "missing"],
				0,
				"cannot write the note's files to missing: no such file or directory",
			],
			[["--out", "a-file"], 0, "cannot write the note's files to a-file: not a directory"],
			[[], 1, "cannot write the note's files to the current directory: permission denied"],
		])(
			"refuses a directory it cannot write to, before the read is spent: %j",
			async (args, fileCount, message) => {
				denied.add(cwd);
				const { run, stderr, client } = reading();
				client.checkNote.mockResolvedValue(existingNote({ fileCount }));
				expect(await run("read", LINK, ...args)).toBe(EXIT.usage);
				expect(stderr.text).toBe(`secret: ${message}\n`);
				expect(client.readNoteInto).not.toHaveBeenCalled();
			},
		);

		it("does not check the current directory for a note without files", async () => {
			denied.add(cwd);
			const { run } = reading();
			expect(await run("read", LINK)).toBe(EXIT.ok);
		});

		it("writes through files.ts when the io gives no directory", async () => {
			const directory = fakeDirectory(cwd);
			files.createOutputDirectory.mockReturnValue(directory);
			const { io, client } = reading();
			client.checkNote.mockResolvedValue(existingNote({ fileCount: 1 }));
			client.readNoteInto.mockImplementation(readWithFiles({ "a.txt": "one" }));
			expect(await runCli(["read", LINK], without(io, "createOutputDirectory"))).toBe(EXIT.ok);
			expect(files.createOutputDirectory).toHaveBeenCalledWith(cwd);
			expect(directory.written).toHaveLength(1);
		});
	});

	describe("failures", () => {
		it("discards the files of a read that fails, and tells why", async () => {
			const { run, stderr, client, directories } = reading();
			client.readNoteInto.mockRejectedValue(
				new SecretApiError("Note not found", 404, { code: "note_not_found" }),
			);
			expect(await run("read", LINK)).toBe(EXIT.notFound);
			expect(directories[0]?.discard).toHaveBeenCalledOnce();
			expect(stderr.text).toContain("this note does not exist");
		});

		it("tells of a file it could not discard, but exits with the read's failure", async () => {
			const { stderr, client, io } = reading({ stderrIsTTY: true });
			const directory = fakeDirectory(cwd);
			directory.discard.mockRejectedValue(new CliError("could not remove a.txt.part"));
			const withDirectory = { ...io, createOutputDirectory: () => directory };
			client.readNoteInto.mockRejectedValue(new SecretApiError("HTTP 500", 500));
			expect(await runCli(["read", LINK], withDirectory)).toBe(EXIT.failure);
			expect(stderr.text).toBe(
				`secret: could not remove a.txt.part\nsecret: ${ORIGIN} failed (HTTP 500)\n`,
			);

			const thrown = reading();
			const other = fakeDirectory(cwd);
			other.discard.mockRejectedValue("gone");
			thrown.client.readNoteInto.mockRejectedValue(new SecretApiError("HTTP 500", 500));
			expect(
				await runCli(["read", LINK], { ...thrown.io, createOutputDirectory: () => other }),
			).toBe(EXIT.failure);
			expect(thrown.stderr.text).toBe(`secret: gone\nsecret: ${ORIGIN} failed (HTTP 500)\n`);
		});

		it("discards the files at Ctrl-C", async () => {
			const controller = new AbortController();
			const { run, stderr, client, directories } = reading({ signal: controller.signal });
			client.readNoteInto.mockImplementation(async () => {
				controller.abort();
				throw controller.signal.reason;
			});
			expect(await run("read", LINK)).toBe(EXIT.interrupted);
			expect(directories[0]?.discard).toHaveBeenCalledOnce();
			expect(stderr.text).toBe("secret: interrupted\n");
		});

		it("refuses a link that is wrong or damaged", async () => {
			const { run, stderr, client } = reading();
			client.readNoteInto.mockRejectedValue(new SecretDecryptionError());
			expect(await run("read", LINK)).toBe(EXIT.refused);
			expect(stderr.text).toBe("secret: wrong password, or the link is wrong or damaged\n");
		});

		it("says that a note of format 0 spent its read", async () => {
			const { run, stderr, client } = reading();
			client.checkNote.mockResolvedValue(FORMAT_0_NOTE);
			client.readNoteInto.mockRejectedValue(new SecretDecryptionError());
			expect(await run("read", FORMAT_0_LINK)).toBe(EXIT.refused);
			expect(stderr.text).toBe(
				"secret: wrong password, or the link is wrong or damaged: the read is spent all the same, a note of format 0 cannot be checked first\n",
			);
		});

		it("says nothing was spent by a numbered link to a note of format 0", async () => {
			const { run, stderr, client } = reading();
			client.checkNote.mockResolvedValue(FORMAT_0_NOTE);
			client.readNoteInto.mockRejectedValue(new SecretDecryptionError());
			expect(await run("read", LINK)).toBe(EXIT.refused);
			expect(stderr.text).toBe("secret: wrong password, or the link is wrong or damaged\n");
		});

		it("never repeats the link", async () => {
			const { run, stderr, client } = reading();
			client.checkNote.mockRejectedValue(
				new SecretApiError("Bad", 400, { code: "invalid_request" }),
			);
			expect(await run("read", LINK, "--out", "out")).toBe(EXIT.failure);
			expect(stderr.text).toBe(
				`secret: ${ORIGIN} refused the request (HTTP 400, invalid_request)\n`,
			);
			expect(stderr.text).not.toContain(KEY);
			expect(stderr.text).not.toContain(NOTE_ID);
		});
	});

	describe("password", () => {
		it("takes SECRET_PASSWORD, without asking", async () => {
			const { run, client, openTerminal } = reading({ env: { SECRET_PASSWORD: "hunter2" } });
			client.checkNote.mockResolvedValue(PASSWORD_NOTE);
			expect(await run("read", LINK)).toBe(EXIT.ok);
			expect(client.readNoteInto).toHaveBeenCalledWith(
				NOTE_ID,
				KEY,
				expect.objectContaining({ password: "hunter2" }),
			);
			expect(openTerminal).not.toHaveBeenCalled();
		});

		it("takes the --password-file", async () => {
			writeFileSync(join(cwd, "password"), "from-file\n");
			const { run, client } = reading();
			client.checkNote.mockResolvedValue(PASSWORD_NOTE);
			expect(await run("read", LINK, "--password-file", "password")).toBe(EXIT.ok);
			expect(client.readNoteInto).toHaveBeenCalledWith(
				NOTE_ID,
				KEY,
				expect.objectContaining({ password: "from-file" }),
			);
		});

		it("asks on the terminal", async () => {
			const terminal = fakeTerminal(["hunter2"]);
			const { run, client } = reading({ terminal });
			client.checkNote.mockResolvedValue(PASSWORD_NOTE);
			expect(await run("read", LINK)).toBe(EXIT.ok);
			expect(client.readNoteInto).toHaveBeenCalledWith(
				NOTE_ID,
				KEY,
				expect.objectContaining({ password: "hunter2" }),
			);
			expect(terminal.write).not.toHaveBeenCalled();
			expect(terminal.close).toHaveBeenCalledOnce();
		});

		it("needs a terminal when no password is given", async () => {
			const { run, stderr, client } = reading();
			client.checkNote.mockResolvedValue(PASSWORD_NOTE);
			expect(await run("read", LINK)).toBe(EXIT.usage);
			expect(stderr.text).toContain("no terminal to ask the password on");
			expect(client.readNoteInto).not.toHaveBeenCalled();
		});

		it("warns before the last attempt", async () => {
			const terminal = fakeTerminal(["hunter2"]);
			const { run, client } = reading({ terminal });
			client.checkNote.mockResolvedValue({ ...PASSWORD_NOTE, passwordAttemptsLeft: 1 });
			expect(await run("read", LINK)).toBe(EXIT.ok);
			expect(terminal.write).toHaveBeenCalledWith(
				"The note takes one more wrong password: the next one deletes it.\n",
			);
		});

		it("warns that a wrong password spends a read of a note of format 0", async () => {
			const terminal = fakeTerminal(["hunter2"]);
			const { run, client } = reading({ terminal });
			client.checkNote.mockResolvedValue({ ...FORMAT_0_NOTE, hasPassword: true });
			expect(await run("read", FORMAT_0_LINK)).toBe(EXIT.ok);
			expect(terminal.write).toHaveBeenCalledWith(
				"A wrong password spends a read of this note: its format cannot check it first.\n",
			);
		});

		it("asks again while the note takes attempts", async () => {
			const terminal = fakeTerminal(["wrong", "wrong again", "right"]);
			const { run, client, directories } = reading({ terminal });
			client.checkNote
				.mockResolvedValueOnce(PASSWORD_NOTE)
				.mockResolvedValueOnce({ ...PASSWORD_NOTE, passwordAttemptsLeft: 4 })
				.mockResolvedValueOnce({ ...PASSWORD_NOTE, passwordAttemptsLeft: 1 });
			client.readNoteInto
				.mockRejectedValueOnce(new SecretDecryptionError())
				.mockRejectedValueOnce(new SecretDecryptionError());
			expect(await run("read", LINK)).toBe(EXIT.ok);
			expect(client.readNoteInto.mock.calls.map(([, , options]) => options.password)).toEqual([
				"wrong",
				"wrong again",
				"right",
			]);
			expect(terminal.write.mock.calls).toEqual([
				["Wrong password: 4 attempts left.\n"],
				["Wrong password: 1 attempt left.\n"],
				["The note takes one more wrong password: the next one deletes it.\n"],
			]);
			expect(directories.map((directory) => directory.discard.mock.calls.length)).toEqual([
				1, 1, 0,
			]);
		});

		it("tells that the last attempt deleted the note", async () => {
			const terminal = fakeTerminal(["wrong"]);
			const { run, stderr, client } = reading({ terminal });
			client.checkNote
				.mockResolvedValueOnce({ ...PASSWORD_NOTE, passwordAttemptsLeft: 1 })
				.mockResolvedValueOnce({ exists: false });
			client.readNoteInto.mockRejectedValue(new SecretDecryptionError());
			expect(await run("read", LINK)).toBe(EXIT.refused);
			expect(stderr.text).toBe(
				"secret: wrong password: that was the last attempt, the note is deleted\n",
			);
		});

		it.each([
			["the note is gone otherwise", { exists: false } as const],
			["no attempt was counted: the link is wrong", PASSWORD_NOTE],
			["the instance counts no attempts", UNCOUNTED_PASSWORD_NOTE],
		])("does not ask again when %s", async (_name, now) => {
			const terminal = fakeTerminal(["wrong", "never asked"]);
			const { run, stderr, client } = reading({ terminal });
			client.checkNote.mockResolvedValueOnce(PASSWORD_NOTE).mockResolvedValueOnce(now);
			client.readNoteInto.mockRejectedValue(new SecretDecryptionError());
			expect(await run("read", LINK)).toBe(EXIT.refused);
			expect(stderr.text).toBe("secret: wrong password, or the link is wrong or damaged\n");
			expect(terminal.readHidden).toHaveBeenCalledOnce();
		});

		it("does not ask again when the first check counted no attempts", async () => {
			const terminal = fakeTerminal(["wrong", "never asked"]);
			const { run, client } = reading({ terminal });
			client.checkNote
				.mockResolvedValueOnce(UNCOUNTED_PASSWORD_NOTE)
				.mockResolvedValueOnce(PASSWORD_NOTE);
			client.readNoteInto.mockRejectedValue(new SecretDecryptionError());
			expect(await run("read", LINK)).toBe(EXIT.refused);
			expect(terminal.readHidden).toHaveBeenCalledOnce();
		});

		it("fails at once on a wrong password given ahead of time", async () => {
			const { run, stderr, client } = reading({ env: { SECRET_PASSWORD: "wrong" } });
			client.checkNote.mockResolvedValue(PASSWORD_NOTE);
			client.readNoteInto.mockRejectedValue(new SecretDecryptionError());
			expect(await run("read", LINK)).toBe(EXIT.refused);
			expect(stderr.text).toBe("secret: wrong password, or the link is wrong or damaged\n");
			expect(client.checkNote).toHaveBeenCalledOnce();
		});
	});

	it("shows its progress on a terminal", async () => {
		const { run, stderr, client } = reading({ stderrIsTTY: true });
		client.readNoteInto.mockImplementation(async (_id, _key, options) => {
			options.onProgress?.({ phase: "downloading", phaseProgress: 0.5, overallProgress: 0.35 });
			return { files: [], createdAt: CREATED_AT, expiresAt: EXPIRES_AT, fileCount: 0 };
		});
		expect(await run("read", LINK)).toBe(EXIT.ok);
		expect(stderr.text).toBe(
			"\r\u001b[KDownloading 35%\r\u001b[KThat was the note's last read: it is deleted.\n",
		);
	});

	describe("the link", () => {
		it("is the first line of stdin when it is piped in", async () => {
			const { run, client, openTerminal } = reading({ stdin: input([` ${LINK}\r\n`, "more"]) });
			expect(await run("read")).toBe(EXIT.ok);
			expect(client.readNoteInto).toHaveBeenCalledWith(NOTE_ID, KEY, expect.anything());
			expect(openTerminal).not.toHaveBeenCalled();
		});

		it("is asked on the terminal, and not shown, when stdin is one", async () => {
			const terminal = fakeTerminal([` ${LINK} `]);
			const { run, client } = reading({ stdin: input([], true), terminal });
			expect(await run("read")).toBe(EXIT.ok);
			expect(terminal.readHidden).toHaveBeenCalledWith("Link: ", expect.any(AbortSignal));
			expect(terminal.close).toHaveBeenCalledOnce();
			expect(client.readNoteInto).toHaveBeenCalledWith(NOTE_ID, KEY, expect.anything());
		});

		it.each([
			[
				"nothing on stdin",
				{ stdin: input([]) },
				"no link on stdin: pipe it in, or give it: secret read <link>",
			],
			[
				"no terminal to ask it on",
				{ stdin: input([], true) },
				"no terminal to ask the link on: pipe it on stdin, or give it: secret read <link>",
			],
			[
				"nothing typed",
				{ stdin: input([], true), terminal: fakeTerminal([" "]) },
				"no link was typed",
			],
		])("is needed: %s", async (_name, setup, message) => {
			const { run, stderr, configs } = reading(setup);
			expect(await run("read")).toBe(EXIT.usage);
			expect(stderr.text).toBe(`secret: ${message}\n`);
			expect(configs).toEqual([]);
		});

		it("is one", async () => {
			const { run, stderr } = reading();
			expect(await run("read", LINK, LINK)).toBe(EXIT.usage);
			expect(stderr.text).toBe("secret: give one link: secret read <link>\n");
			expect(stderr.text).not.toContain(KEY);
		});

		it.each([["#1.cut-short"], [`#2.${KEY.slice(2)}`]])(
			"is refused wrong or damaged before any request: %s",
			async (fragment) => {
				const { run, stderr, configs } = reading();
				expect(await run("read", `${ORIGIN}/note/${NOTE_ID}${fragment}`)).toBe(EXIT.refused);
				expect(stderr.text).toBe("secret: the link is wrong or damaged\n");
				expect(configs).toEqual([]);
			},
		);

		it("is refused without its key", async () => {
			const { run, stderr } = reading();
			expect(await run("read", `${ORIGIN}/note/${NOTE_ID}`)).toBe(EXIT.usage);
			expect(stderr.text).toBe(
				"secret: the link has no key: give the whole of it, quoted, the part after # included\n",
			);
		});

		it("is refused with an unknown option", async () => {
			const { run, stderr } = reading();
			expect(await run("read", LINK, "--instance", ORIGIN)).toBe(EXIT.usage);
			expect(stderr.text).toBe("secret: unknown option '--instance': see secret read --help\n");
		});
	});
});

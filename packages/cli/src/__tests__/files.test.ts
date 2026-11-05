import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import {
	lstat,
	mkdir,
	mkdtemp,
	open,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { NoteFileInfo } from "@largerio/secret-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliError } from "../errors.js";
import { createOutputDirectory, type OutputDirectory } from "../files.js";

vi.mock("node:fs/promises", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...fs,
		lstat: vi.fn(fs.lstat),
		open: vi.fn(fs.open),
		rename: vi.fn(fs.rename),
		unlink: vi.fn(fs.unlink),
	};
});

const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

let dir: string;
let outside: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "secret-cli-files-"));
	outside = await mkdtemp(join(tmpdir(), "secret-cli-outside-"));
});

afterEach(async () => {
	for (const mock of [lstat, open, rename, unlink]) {
		vi.mocked(mock).mockReset();
	}
	await rm(dir, { recursive: true, force: true });
	await rm(outside, { recursive: true, force: true });
});

function info(name: string, size = 0): NoteFileInfo {
	return { name, type: "text/plain", size };
}

function bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

function errno(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(`${code}: simulated`), { code });
}

async function listed(): Promise<string[]> {
	return (await readdir(dir)).sort();
}

function savedNames(out: OutputDirectory): string[] {
	return out.written.map((file) => basename(file.path));
}

/** Opens and writes every file, then closes them in order, as the SDK reads a format 1 note. */
async function readInto(out: OutputDirectory, names: ReadonlyArray<string>): Promise<void> {
	const writers: WritableStreamDefaultWriter<Uint8Array>[] = [];
	for (const [index, name] of names.entries()) {
		const writer = (await out.open(info(name), index)).getWriter();
		await writer.write(bytes(`file ${index}`));
		writers.push(writer);
	}
	for (const writer of writers) {
		await writer.close();
	}
}

/** The `.part` file's handle, handed to `change` as it is opened. */
function onPartOpened(change: (handle: FileHandle) => void): void {
	vi.mocked(open).mockImplementationOnce(async (...args) => {
		const handle = await actual.open(...args);
		change(handle);
		return handle;
	});
}

function tick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("createOutputDirectory", () => {
	it("writes a file to a .part file, renamed under its name once closed", async () => {
		const out = createOutputDirectory(dir);
		const writer = (
			await out.open({ name: "notes.txt", type: "text/plain", size: 11 }, 0)
		).getWriter();
		await writer.write(bytes("hello "));
		await writer.write(bytes("world"));

		expect(await listed()).toEqual(["notes.txt.part"]);
		expect(out.written).toEqual([]);

		await writer.close();

		expect(await listed()).toEqual(["notes.txt"]);
		expect(await readFile(join(dir, "notes.txt"), "utf8")).toBe("hello world");
		expect(out.written).toEqual([
			{ name: "notes.txt", path: join(dir, "notes.txt"), type: "text/plain", size: 11 },
		]);
	});

	it("creates its files readable and writable by their owner only", async () => {
		const out = createOutputDirectory(dir);
		const writer = (await out.open(info("a.txt"), 0)).getWriter();

		expect((await stat(join(dir, "a.txt.part"))).mode & 0o777).toBe(0o600);

		await writer.close();

		expect((await stat(join(dir, "a.txt"))).mode & 0o777).toBe(0o600);
		expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("");
	});

	it("removes the .part file of a stream aborted", async () => {
		const out = createOutputDirectory(dir);
		const writer = (await out.open(info("a.txt"), 0)).getWriter();
		await writer.write(bytes("not checked"));

		await writer.abort(new Error("tampered"));

		expect(await listed()).toEqual([]);
		expect(out.written).toEqual([]);
	});

	it("lists the files in the note's order, with the names sent", async () => {
		const out = createOutputDirectory(dir);

		await readInto(out, ["../b.txt", "a.txt"]);

		expect(out.written).toEqual([
			{ name: "../b.txt", path: join(dir, "b.txt"), type: "text/plain", size: 6 },
			{ name: "a.txt", path: join(dir, "a.txt"), type: "text/plain", size: 6 },
		]);
		expect(await readFile(join(dir, "b.txt"), "utf8")).toBe("file 0");
	});
});

describe("names", () => {
	it.each([
		["report.pdf", "report.pdf"],
		["../../.ssh/authorized_keys", "authorized_keys"],
		["/etc/passwd", "passwd"],
		["C:\\Windows\\System32\\evil.dll", "evil.dll"],
		["\\\\server\\share\\x.txt", "x.txt"],
		["..\\..\\x.txt", "x.txt"],
		["C:evil.txt", "C_evil.txt"],
		["a.txt:stream", "a.txt_stream"],
		["a\u0000b.txt", "a_b.txt"],
		[".bashrc", "bashrc"],
		[".bash_login", "bash_login"],
		[".git/config", "config"],
		[".git", "git"],
		["...profile", "profile"],
		[" .  .zshrc", "zshrc"],
		["\u200B.bashrc", "_.bashrc"],
		["\u200D.profile", "profile"],
		["invoice\u202Efdp.exe", "invoice_fdp.exe"],
		["\u2066a\u2069.txt", "_a_.txt"],
		["a\u200E\u200F\u061C.txt", "a___.txt"],
		["a\uFEFF.txt", "a_.txt"],
		["family 👨\u200D👩\u200D👧.png", "family 👨\u200D👩\u200D👧.png"],
		["report.pdf. . ", "report.pdf"],
		["report.pdf\u200D", "report.pdf"],
		["  notes.txt  ", "notes.txt"],
		["-rf", "rf"],
		["--help", "help"],
		["CON", "_CON"],
		["nul.txt", "_nul.txt"],
		["Com1.tar.gz", "_Com1.tar.gz"],
		["aux .txt", "_aux .txt"],
		["LPT¹", "_LPT¹"],
		["conin$", "_conin$"],
		["console.txt", "console.txt"],
		["com10", "com10"],
		['a<b>c:d"e|f?g*h', "a_b_c_d_e_f_g_h"],
		["\uD800x.txt", "_x.txt"],
		["e\u0301te\u0301.txt", "\u00E9t\u00E9.txt"],
		["a\u2028b\u2029c", "a_b_c"],
		["a\nb\tc\rd", "a_b_c_d"],
		["a\u007Fb\u0085c\u009Bd", "a_b_c_d"],
		["\u001B[31mred", "_[31mred"],
		["", "file-1"],
		[".", "file-1"],
		["..", "file-1"],
		["...", "file-1"],
		["/", "file-1"],
		["dir/", "file-1"],
		[" . - . ", "file-1"],
	])("writes %j as %j", async (sent, expected) => {
		const out = createOutputDirectory(dir);

		await readInto(out, [sent]);

		expect(await listed()).toEqual([expected]);
		expect(out.written[0]).toMatchObject({ name: sent, path: join(dir, expected) });
	});

	it("numbers a file left without a name by its place in the note", async () => {
		const out = createOutputDirectory(dir);

		await (await out.open(info("/"), 2)).close();

		expect(await listed()).toEqual(["file-3"]);
	});

	it("cuts a long name to 255 bytes, keeping its extension", async () => {
		const out = createOutputDirectory(dir);
		const writer = (await out.open(info(`${"a".repeat(300)}.txt`), 0)).getWriter();

		expect(await listed()).toEqual([`${"a".repeat(246)}.txt.part`]);

		await writer.close();

		expect(await listed()).toEqual([`${"a".repeat(251)}.txt`]);
	});

	it("cuts a name between two characters", async () => {
		const out = createOutputDirectory(dir);

		await readInto(out, [`${"é".repeat(200)}.txt`, `${"😀".repeat(100)}.pdf`]);

		expect(savedNames(out)).toEqual([`${"é".repeat(125)}.txt`, `${"😀".repeat(62)}.pdf`]);
		for (const name of await listed()) {
			expect(Buffer.byteLength(name)).toBeLessThanOrEqual(255);
			expect(name).not.toContain("\uFFFD");
		}
	});

	it("keeps a suffixed long name within 255 bytes", async () => {
		const out = createOutputDirectory(dir);
		const name = `${"a".repeat(300)}.txt`;

		await readInto(out, [name, name]);

		expect(savedNames(out)).toEqual([`${"a".repeat(251)}.txt`, `${"a".repeat(247)} (1).txt`]);
	});

	it("cuts a name whose extension is too long as a whole", async () => {
		const out = createOutputDirectory(dir);

		await readInto(out, [`a.${"b".repeat(300)}`]);

		expect(await listed()).toEqual([`a.${"b".repeat(253)}`]);
	});

	it("drops the dots and spaces a cut leaves last", async () => {
		const out = createOutputDirectory(dir);

		await readInto(out, [`${"a".repeat(254)} b`, `${"c".repeat(254)}.${"d".repeat(30)}`]);

		expect(savedNames(out)).toEqual(["a".repeat(254), "c".repeat(254)]);
	});
});

describe("never overwrites", () => {
	it("leaves an existing file as it is", async () => {
		await writeFile(join(dir, "a.txt"), "mine");
		await writeFile(join(dir, "a (1).txt"), "mine too");
		const out = createOutputDirectory(dir);

		await readInto(out, ["a.txt"]);

		expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("mine");
		expect(await readFile(join(dir, "a (1).txt"), "utf8")).toBe("mine too");
		expect(await readFile(join(dir, "a (2).txt"), "utf8")).toBe("file 0");
		expect(savedNames(out)).toEqual(["a (2).txt"]);
	});

	it("leaves an existing directory as it is", async () => {
		await mkdir(join(dir, "docs"));
		const out = createOutputDirectory(dir);

		await readInto(out, ["docs"]);

		expect((await stat(join(dir, "docs"))).isDirectory()).toBe(true);
		expect(savedNames(out)).toEqual(["docs (1)"]);
	});

	it("never follows a link, dangling or not", async () => {
		await writeFile(join(outside, "target"), "precious");
		await symlink(join(outside, "target"), join(dir, "a.txt"));
		await symlink(join(outside, "missing"), join(dir, "b.txt"));
		const out = createOutputDirectory(dir);

		await readInto(out, ["a.txt", "b.txt"]);

		expect(savedNames(out)).toEqual(["a (1).txt", "b (1).txt"]);
		expect(await readdir(outside)).toEqual(["target"]);
		expect(await readFile(join(outside, "target"), "utf8")).toBe("precious");
		expect((await lstat(join(dir, "a.txt"))).isSymbolicLink()).toBe(true);
		expect((await lstat(join(dir, "b.txt"))).isSymbolicLink()).toBe(true);
	});

	it("never writes through a link where its .part file would go", async () => {
		await writeFile(join(outside, "target"), "precious");
		await symlink(join(outside, "target"), join(dir, "a.txt.part"));
		const out = createOutputDirectory(dir);

		await readInto(out, ["a.txt"]);

		expect(savedNames(out)).toEqual(["a (1).txt"]);
		expect(await readFile(join(outside, "target"), "utf8")).toBe("precious");
	});

	it("leaves a file made while the note was read, and takes the next name", async () => {
		const out = createOutputDirectory(dir);
		const writer = (await out.open(info("a.txt"), 0)).getWriter();
		await writer.write(bytes("from the note"));
		await writeFile(join(dir, "a.txt"), "made meanwhile");

		await writer.close();

		expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("made meanwhile");
		expect(await readFile(join(dir, "a (1).txt"), "utf8")).toBe("from the note");
	});

	it("skips the names other files of the note hold when taking the next one", async () => {
		const out = createOutputDirectory(dir);
		const first = (await out.open(info("a"), 0)).getWriter();
		const second = (await out.open(info("a"), 1)).getWriter();
		await writeFile(join(dir, "a"), "made meanwhile");

		await first.close();
		await second.close();

		expect(savedNames(out)).toEqual(["a (2)", "a (1)"]);
		expect(await readFile(join(dir, "a"), "utf8")).toBe("made meanwhile");
	});

	it("gives the same note the same names, however its streams are closed", async () => {
		const out = createOutputDirectory(dir);
		const names = ["report.pdf", "Report.PDF", "report.pdf", "report (1).pdf"];
		const writers: WritableStreamDefaultWriter<Uint8Array>[] = [];
		for (const [index, name] of names.entries()) {
			const writer = (await out.open(info(name), index)).getWriter();
			await writer.write(bytes(`file ${index}`));
			writers.push(writer);
		}

		await Promise.all(writers.toReversed().map((writer) => writer.close()));

		expect(savedNames(out)).toEqual([
			"report.pdf",
			"Report (1).PDF",
			"report (2).pdf",
			"report (1) (1).pdf",
		]);
		expect(out.written.map((file) => file.name)).toEqual(names);
		for (const [index, name] of savedNames(out).entries()) {
			expect(await readFile(join(dir, name), "utf8")).toBe(`file ${index}`);
		}
	});

	it("keeps apart names a case-insensitive or normalizing file system holds as one", async () => {
		const out = createOutputDirectory(dir);

		await readInto(out, [
			"A.txt",
			"a.txt",
			"\u00E9.txt",
			"e\u0301.txt",
			"Straße",
			"STRASSE",
			"\uFB01le.txt",
			"file.txt",
			"\uFF46ile.txt",
		]);

		expect(savedNames(out)).toEqual([
			"A.txt",
			"a (1).txt",
			"\u00E9.txt",
			"\u00E9 (1).txt",
			"Straße",
			"STRASSE (1)",
			"\uFB01le.txt",
			"file (1).txt",
			"\uFF46ile (2).txt",
		]);
	});

	it("keeps a file's name apart from another's .part file", async () => {
		const out = createOutputDirectory(dir);

		await readInto(out, ["a", "a.part"]);
		await readInto(createOutputDirectory(outside), ["a.part", "a"]);

		expect(savedNames(out)).toEqual(["a", "a (1).part"]);
		expect((await readdir(outside)).sort()).toEqual(["a (1)", "a.part"]);
	});

	it("numbers a name sent many times", async () => {
		const out = createOutputDirectory(dir);
		const names = Array.from({ length: 50 }, () => "x");

		await readInto(out, names);

		expect(savedNames(out)).toEqual(["x", ...names.slice(1).map((_, n) => `x (${n + 1})`)]);
	});

	it("names the files of a note read one after the other", async () => {
		const out = createOutputDirectory(dir);
		for (const [index, name] of ["a.txt", "a.txt"].entries()) {
			const writer = (await out.open(info(name), index)).getWriter();
			await writer.write(bytes(`file ${index}`));
			await writer.close();
		}

		expect(savedNames(out)).toEqual(["a.txt", "a (1).txt"]);
	});
});

describe("discard", () => {
	it("removes the .part files of a read cut short, and keeps the files closed before", async () => {
		const out = createOutputDirectory(dir);
		await (await out.open(info("kept.txt"), 0)).close();
		const writer = (await out.open(info("cut.txt"), 1)).getWriter();
		await writer.write(bytes("half"));

		await out.discard();

		expect(await listed()).toEqual(["kept.txt"]);
		expect(out.written.map((file) => file.name)).toEqual(["kept.txt"]);
	});

	it("is idempotent", async () => {
		const out = createOutputDirectory(dir);
		await out.open(info("a.txt"), 0);

		await out.discard();
		await out.discard();

		expect(await listed()).toEqual([]);
	});

	it("refuses what follows: an open, a write, a close", async () => {
		const out = createOutputDirectory(dir);
		const writing = (await out.open(info("a.txt"), 0)).getWriter();
		const closing = (await out.open(info("b.txt"), 1)).getWriter();

		await out.discard();

		await expect(out.open(info("c.txt"), 2)).rejects.toThrow(
			"the read was interrupted: its files were discarded",
		);
		await expect(writing.write(bytes("more"))).rejects.toThrow(CliError);
		await expect(closing.close()).rejects.toThrow(CliError);
		expect(await listed()).toEqual([]);
		expect(out.written).toEqual([]);
	});

	it("keeps nothing closed while it runs", async () => {
		const out = createOutputDirectory(dir);
		const writer = (await out.open(info("a.txt"), 0)).getWriter();

		const discarding = out.discard();
		await expect(writer.close()).rejects.toThrow(CliError);
		await discarding;

		expect(await listed()).toEqual([]);
		expect(out.written).toEqual([]);
	});

	it("removes the files being opened", async () => {
		const out = createOutputDirectory(dir);
		const opening = Promise.allSettled([out.open(info("a"), 0), out.open(info("b"), 1)]);

		await out.discard();

		for (const result of await opening) {
			expect(result).toMatchObject({ status: "rejected", reason: expect.any(CliError) });
		}
		expect(await listed()).toEqual([]);
	});

	it("waits for a write under way", async () => {
		const gate = Promise.withResolvers<void>();
		onPartOpened((handle) => {
			const write = handle.writeFile.bind(handle);
			vi.spyOn(handle, "writeFile").mockImplementationOnce(async (data) => {
				await gate.promise;
				await write(data);
			});
		});
		const out = createOutputDirectory(dir);
		const writer = (await out.open(info("a.txt"), 0)).getWriter();
		const writing = writer.write(bytes("data"));
		await tick();

		let discarded = false;
		const discarding = out.discard().then(() => {
			discarded = true;
		});
		await tick();
		expect(discarded).toBe(false);
		gate.resolve();
		await writing;
		await discarding;

		expect(await listed()).toEqual([]);
	});

	it("waits for a rename under way, and keeps its file", async () => {
		const gate = Promise.withResolvers<void>();
		vi.mocked(rename).mockImplementationOnce(async (from, to) => {
			await gate.promise;
			await actual.rename(from, to);
		});
		const out = createOutputDirectory(dir);
		const writer = (await out.open(info("a.txt"), 0)).getWriter();
		const closing = writer.close();
		await tick();

		const discarding = out.discard();
		gate.resolve();
		await closing;
		await discarding;

		expect(await listed()).toEqual(["a.txt"]);
		expect(savedNames(out)).toEqual(["a.txt"]);
	});
});

describe("failures", () => {
	it("rejects a write the disk refuses, and removes its .part file", async () => {
		onPartOpened((handle) => {
			vi.spyOn(handle, "writeFile").mockRejectedValueOnce(errno("ENOSPC"));
		});
		const out = createOutputDirectory(dir);
		const writer = (await out.open(info("a.txt"), 0)).getWriter();

		const failure = await writer.write(bytes("x")).catch((err: unknown) => err);

		expect(failure).toBeInstanceOf(CliError);
		expect(failure).toMatchObject({
			message: `could not write ${join(dir, "a.txt.part")}: the disk is full`,
			exitCode: 1,
			cause: expect.objectContaining({ code: "ENOSPC" }),
		});
		expect(await listed()).toEqual([]);
		await writer.abort(failure);
		await out.discard();
		expect(out.written).toEqual([]);
	});

	it("rejects a write with its own failure when its .part file cannot be removed", async () => {
		onPartOpened((handle) => {
			vi.spyOn(handle, "writeFile").mockRejectedValueOnce(errno("EIO"));
		});
		vi.mocked(unlink).mockRejectedValueOnce(errno("EBUSY"));
		const out = createOutputDirectory(dir);
		const writer = (await out.open(info("a.txt"), 0)).getWriter();

		await expect(writer.write(bytes("x"))).rejects.toThrow(
			`could not write ${join(dir, "a.txt.part")}: an input/output error`,
		);
		await expect(out.discard()).rejects.toThrow(
			`could not remove ${join(dir, "a.txt.part")}, which holds part of a note: delete it: the file is in use`,
		);
		expect(await listed()).toEqual(["a.txt.part"]);
	});

	it("creates no directory", async () => {
		const missing = join(dir, "missing");
		const out = createOutputDirectory(missing);

		await expect(out.open(info("a.txt"), 0)).rejects.toThrow(
			`could not create ${join(missing, "a.txt.part")}: no such file or directory`,
		);
		expect(await listed()).toEqual([]);
	});

	it("refuses a path that is not a directory", async () => {
		await writeFile(join(dir, "file"), "");
		const out = createOutputDirectory(join(dir, "file"));

		await expect(out.open(info("a.txt"), 0)).rejects.toThrow(
			`could not look up ${join(dir, "file", "a.txt")}: not a directory`,
		);
	});

	it.each([
		[errno("EACCES"), "permission denied"],
		[errno("EWEIRD"), "EWEIRD"],
		[new Error("no code"), "no code"],
		["a failure", "a failure"],
	])("tells why a .part file could not be created (%s)", async (error, reason) => {
		vi.mocked(open).mockRejectedValueOnce(error);
		const out = createOutputDirectory(dir);

		await expect(out.open(info("a.txt"), 0)).rejects.toThrow(
			`could not create ${join(dir, "a.txt.part")}: ${reason}`,
		);
	});

	it("removes the .part file when its name cannot be created", async () => {
		vi.mocked(open).mockImplementation(async (path, ...rest) => {
			if (path === join(dir, "a.txt")) {
				throw errno("EIO");
			}
			return actual.open(path, ...rest);
		});
		const out = createOutputDirectory(dir);
		const writer = (await out.open(info("a.txt"), 0)).getWriter();

		await expect(writer.close()).rejects.toThrow(
			`could not create ${join(dir, "a.txt")}: an input/output error`,
		);
		expect(await listed()).toEqual([]);
		expect(out.written).toEqual([]);
	});

	it("removes the .part file and the name it holds when the rename fails", async () => {
		vi.mocked(rename).mockRejectedValueOnce(errno("EIO"));
		const out = createOutputDirectory(dir);
		const writer = (await out.open(info("a.txt"), 0)).getWriter();

		await expect(writer.close()).rejects.toThrow(
			`could not save ${join(dir, "a.txt")}: an input/output error`,
		);
		expect(await listed()).toEqual([]);
		expect(out.written).toEqual([]);
	});

	it("keeps the files closed before a close fails, and drops those the SDK aborts", async () => {
		vi.mocked(rename).mockImplementation(async (from, to) => {
			if (to === join(dir, "b.txt")) {
				throw errno("EIO");
			}
			await actual.rename(from, to);
		});
		const out = createOutputDirectory(dir);
		const writers: WritableStreamDefaultWriter<Uint8Array>[] = [];
		for (const [index, name] of ["a.txt", "b.txt", "c.txt"].entries()) {
			const writer = (await out.open(info(name), index)).getWriter();
			await writer.write(bytes(`file ${index}`));
			writers.push(writer);
		}

		// What `readNoteInto` does: close in order, abort them all on a failure.
		const closing = (async () => {
			for (const writer of writers) {
				await writer.close();
			}
		})();
		await expect(closing).rejects.toThrow(`could not save ${join(dir, "b.txt")}`);
		await Promise.all(writers.map((writer) => writer.abort(new Error("failed")).catch(() => 0)));

		expect(await listed()).toEqual(["a.txt"]);
		expect(savedNames(out)).toEqual(["a.txt"]);
	});

	it("gives up on a name after many suffixes", async () => {
		vi.mocked(lstat).mockResolvedValue({} as Stats);
		const out = createOutputDirectory(dir);

		await expect(out.open(info("a.txt"), 0)).rejects.toThrow(
			`found no free name for a.txt in ${dir}`,
		);
		expect(await listed()).toEqual([]);
	});

	it("tells of a .part file it could not remove", async () => {
		const out = createOutputDirectory(dir);
		const writer = (await out.open(info("a.txt"), 0)).getWriter();
		vi.mocked(unlink).mockRejectedValueOnce(errno("EPERM"));

		await writer.abort(new Error("tampered")).catch(() => undefined);

		await expect(out.discard()).rejects.toThrow(
			`could not remove ${join(dir, "a.txt.part")}, which holds part of a note: delete it: permission denied`,
		);
	});

	it("aborts a stream whose .part file is gone already", async () => {
		const out = createOutputDirectory(dir);
		const writer = (await out.open(info("a.txt"), 0)).getWriter();
		await actual.unlink(join(dir, "a.txt.part"));

		await writer.abort(new Error("tampered"));
		await out.discard();

		expect(await listed()).toEqual([]);
	});
});

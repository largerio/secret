import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	askPassword,
	givenPassword,
	passwordOfNewNote,
	readApiKey,
	withTerminal,
} from "../credentials.js";
import { EXIT } from "../errors.js";
import { fakeTerminal, harness } from "./harness.js";

const dir = mkdtempSync(join(tmpdir(), "secret-cli-credentials-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function file(name: string, content: string): string {
	writeFileSync(join(dir, name), content);
	return name;
}

describe("readApiKey", () => {
	it("takes SECRET_API_KEY, trimmed, blank counting as unset", async () => {
		expect(await readApiKey(harness({ env: { SECRET_API_KEY: " key \n" } }).io)).toBe("key");
		expect(await readApiKey(harness({ env: { SECRET_API_KEY: "  " } }).io)).toBeUndefined();
		expect(await readApiKey(harness().io)).toBeUndefined();
	});

	it("reads the file SECRET_API_KEY_FILE names, relative to the working directory", async () => {
		const path = file("key", "  from-file \r\n");
		const { io } = harness({ cwd: dir, env: { SECRET_API_KEY_FILE: path, SECRET_API_KEY: "" } });
		expect(await readApiKey(io)).toBe("from-file");
	});

	it("refuses both at once", async () => {
		const { io } = harness({ env: { SECRET_API_KEY: "key", SECRET_API_KEY_FILE: "path" } });
		await expect(readApiKey(io)).rejects.toMatchObject({
			message: "set SECRET_API_KEY or SECRET_API_KEY_FILE, not both",
			exitCode: EXIT.usage,
		});
	});

	it("refuses a file it cannot read, or an empty one, naming the path only", async () => {
		const missing = harness({ cwd: dir, env: { SECRET_API_KEY_FILE: "missing" } });
		await expect(readApiKey(missing.io)).rejects.toMatchObject({
			message: "SECRET_API_KEY_FILE: cannot read missing (ENOENT)",
			exitCode: EXIT.usage,
		});
		const empty = harness({ cwd: dir, env: { SECRET_API_KEY_FILE: file("empty", " \n") } });
		await expect(readApiKey(empty.io)).rejects.toMatchObject({
			message: "SECRET_API_KEY_FILE: empty is empty",
			exitCode: EXIT.usage,
		});
	});
});

describe("givenPassword", () => {
	it("takes SECRET_PASSWORD as it is, before any file", async () => {
		const { io } = harness({ env: { SECRET_PASSWORD: " spaced " } });
		expect(await givenPassword(io, "ignored")).toBe(" spaced ");
	});

	it("refuses an empty SECRET_PASSWORD", async () => {
		const { io } = harness({ env: { SECRET_PASSWORD: "" } });
		await expect(givenPassword(io, undefined)).rejects.toMatchObject({
			message: "SECRET_PASSWORD is set, but an empty password is no password",
			exitCode: EXIT.usage,
		});
	});

	it("takes the first line of the file, without its line ending", async () => {
		const { io } = harness({ cwd: dir });
		expect(await givenPassword(io, file("crlf", "first \r\nsecond\n"))).toBe("first ");
		expect(await givenPassword(io, file("lf", "only\n"))).toBe("only");
		expect(await givenPassword(io, file("bare", "bare"))).toBe("bare");
	});

	it("refuses a file whose first line is empty", async () => {
		const { io } = harness({ cwd: dir });
		await expect(givenPassword(io, file("blank", "\nsecond"))).rejects.toMatchObject({
			message: "--password-file: the first line of blank is empty",
			exitCode: EXIT.usage,
		});
	});

	it("answers undefined when nothing is given", async () => {
		expect(await givenPassword(harness().io, undefined)).toBeUndefined();
	});
});

describe("withTerminal", () => {
	it("closes the terminal after use, failed or not", async () => {
		const terminal = fakeTerminal([]);
		const { io } = harness({ terminal });
		await expect(withTerminal(io, async () => "done")).resolves.toBe("done");
		await expect(withTerminal(io, () => Promise.reject(new Error("failed")))).rejects.toThrow(
			"failed",
		);
		expect(terminal.close).toHaveBeenCalledTimes(2);
	});

	it("refuses without a terminal", async () => {
		await expect(withTerminal(harness().io, async () => "done")).rejects.toMatchObject({
			message: "no terminal to ask the password on: set SECRET_PASSWORD, or pass --password-file",
			exitCode: EXIT.usage,
		});
	});

	it("has none when the io gives no way to open one", async () => {
		const { io } = harness();
		const { openTerminal: _, ...withoutTerminal } = io;
		await expect(withTerminal(withoutTerminal, async () => "done")).rejects.toMatchObject({
			exitCode: EXIT.usage,
		});
	});
});

describe("askPassword", () => {
	it("refuses an empty password", async () => {
		const terminal = fakeTerminal([""]);
		await expect(askPassword(terminal, new AbortController().signal)).rejects.toMatchObject({
			message: "an empty password is no password",
			exitCode: EXIT.usage,
		});
		expect(terminal.readHidden).toHaveBeenCalledWith("Password: ", expect.any(AbortSignal));
	});
});

describe("passwordOfNewNote", () => {
	it("asks twice on the terminal", async () => {
		const terminal = fakeTerminal(["hunter2", "hunter2"]);
		expect(await passwordOfNewNote(harness({ terminal }).io, undefined)).toBe("hunter2");
		expect(terminal.readHidden.mock.calls.map(([prompt]) => prompt)).toEqual([
			"Password: ",
			"Repeat the password: ",
		]);
	});

	it("refuses two passwords that differ", async () => {
		const terminal = fakeTerminal(["hunter2", "hunter3"]);
		await expect(passwordOfNewNote(harness({ terminal }).io, undefined)).rejects.toMatchObject({
			message: "the passwords do not match",
			exitCode: EXIT.usage,
		});
		expect(terminal.close).toHaveBeenCalledOnce();
	});

	it("takes a password given ahead of time without asking", async () => {
		const terminal = fakeTerminal([]);
		const { io, openTerminal } = harness({ terminal, env: { SECRET_PASSWORD: "given" } });
		expect(await passwordOfNewNote(io, undefined)).toBe("given");
		expect(openTerminal).not.toHaveBeenCalled();
	});
});

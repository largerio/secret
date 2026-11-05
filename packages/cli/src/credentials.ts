import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CliError, EXIT, reasonOf } from "./errors.js";
import type { Io, Terminal } from "./types.js";

/** Why a file of a secret cannot be read: never what it holds. */
async function readSecretFile(io: Io, path: string, name: string): Promise<string> {
	try {
		return await readFile(resolve(io.cwd, path), "utf8");
	} catch (err) {
		throw new CliError(`${name}: cannot read ${path}: ${reasonOf(err)}`, EXIT.usage);
	}
}

/**
 * The API key of a write: `SECRET_API_KEY`, or the file `SECRET_API_KEY_FILE`
 * names, as the server reads its own secrets. Blank counts as unset, both at
 * once is refused. There is no option for it: the shell's history and `ps`
 * would show it.
 */
export async function readApiKey(io: Io): Promise<string | undefined> {
	const value = io.env["SECRET_API_KEY"]?.trim();
	const path = io.env["SECRET_API_KEY_FILE"]?.trim();
	if (!path) {
		return value || undefined;
	}
	if (value) {
		throw new CliError("set SECRET_API_KEY or SECRET_API_KEY_FILE, not both", EXIT.usage);
	}
	const key = (await readSecretFile(io, path, "SECRET_API_KEY_FILE")).trim();
	if (key === "") {
		throw new CliError(`SECRET_API_KEY_FILE: ${path} is empty`, EXIT.usage);
	}
	return key;
}

const EMPTY_PASSWORD = "an empty password is no password";

/**
 * A password given ahead of time: `SECRET_PASSWORD`, else the first line of
 * the `--password-file`, used as typed; undefined when neither is given.
 */
export async function givenPassword(io: Io, file: string | undefined): Promise<string | undefined> {
	const value = io.env["SECRET_PASSWORD"];
	if (value !== undefined) {
		if (value === "") {
			throw new CliError(`SECRET_PASSWORD is set, but ${EMPTY_PASSWORD}`, EXIT.usage);
		}
		return value;
	}
	if (file === undefined) {
		return undefined;
	}
	const content = await readSecretFile(io, file, "--password-file");
	const end = content.indexOf("\n");
	const line = end === -1 ? content : content.slice(0, end);
	const password = line.endsWith("\r") ? line.slice(0, -1) : line;
	if (password === "") {
		throw new CliError(`--password-file: the first line of ${file} is empty`, EXIT.usage);
	}
	return password;
}

/** Runs `use` on the controlling terminal, closed afterwards; refused without one. */
export async function withTerminal<T>(io: Io, use: (terminal: Terminal) => Promise<T>): Promise<T> {
	const terminal = io.openTerminal?.();
	if (terminal === undefined) {
		throw new CliError(
			"no terminal to ask the password on: set SECRET_PASSWORD, or pass --password-file",
			EXIT.usage,
		);
	}
	try {
		return await use(terminal);
	} finally {
		terminal.close();
	}
}

/** Asks a password on the terminal. */
export async function askPassword(
	terminal: Terminal,
	signal: AbortSignal,
	prompt = "Password: ",
): Promise<string> {
	const password = await terminal.readHidden(prompt, signal);
	if (password === "") {
		throw new CliError(EMPTY_PASSWORD, EXIT.usage);
	}
	return password;
}

/** The password of a note being written: given, or asked twice on the terminal. */
export async function passwordOfNewNote(io: Io, file: string | undefined): Promise<string> {
	const given = await givenPassword(io, file);
	if (given !== undefined) {
		return given;
	}
	return withTerminal(io, async (terminal) => {
		const password = await askPassword(terminal, io.signal);
		const again = await terminal.readHidden("Repeat the password: ", io.signal);
		if (again !== password) {
			throw new CliError("the passwords do not match", EXIT.usage);
		}
		return password;
	});
}

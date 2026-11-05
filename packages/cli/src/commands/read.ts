import { constants, type Stats } from "node:fs";
import { access, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
	type ExistingNoteInfo,
	type ReadNoteIntoResult,
	SecretDecryptionError,
} from "@largerio/secret-sdk";
import { askPassword, givenPassword, withTerminal } from "../credentials.js";
import { CliError, EXIT, reasonOf } from "../errors.js";
import { notFound, translateError, WRONG_PASSWORD_OR_LINK } from "../failures.js";
import { createOutputDirectory, type WrittenFile } from "../files.js";
import { connect, formatOfLink, linkOf, type NoteLink } from "../instance.js";
import { COMMON_OPTIONS, optionalLink, parsing } from "../options.js";
import { readLink } from "../stdin.js";
import {
	createScreen,
	describeProgress,
	type Screen,
	writeJson,
	writeLine,
	writeText,
} from "../terminal.js";
import type { Io, NotesClient } from "../types.js";
import { formatSize } from "../units.js";

const OPTIONS = {
	...COMMON_OPTIONS,
	out: { type: "string", short: "o" },
	"password-file": { type: "string" },
} as const;

/**
 * A note of format 0 is served before its key is checked: a failure to
 * decrypt it spent a read all the same.
 */
const FORMAT_0_REFUSED = `${WRONG_PASSWORD_OR_LINK}: the read is spent all the same, a note of format 0 cannot be checked first`;

/**
 * The link to read: the argument, else the first line of stdin when it is
 * piped in, else typed on the terminal without being shown. An argument stays
 * in the shell's history and shows in `ps`; the other two leave no trace.
 */
async function linkToRead(positionals: ReadonlyArray<string>, io: Io): Promise<NoteLink> {
	const given = optionalLink(positionals, "read");
	if (given !== undefined) {
		return linkOf(given);
	}
	if (!io.stdin.isTTY) {
		return linkOf(await readLink(io.stdin, io.signal));
	}
	const typed = await withTerminal(
		io,
		(terminal) => terminal.readHidden("Link: ", io.signal),
		"no terminal to ask the link on: pipe it on stdin, or give it: secret read <link>",
	);
	if (typed.trim() === "") {
		throw new CliError("no link was typed", EXIT.usage);
	}
	return linkOf(typed.trim());
}

/**
 * Checks, before a read is spent, that the files have somewhere to go: a
 * note read and burned for nothing could not be read again.
 */
async function assertWritableDirectory(dir: string, given: string | undefined): Promise<void> {
	const name = given ?? "the current directory";
	let info: Stats;
	try {
		info = await stat(dir);
		await access(dir, constants.W_OK);
	} catch (err) {
		throw new CliError(`cannot write the note's files to ${name}: ${reasonOf(err)}`, EXIT.usage);
	}
	if (!info.isDirectory()) {
		throw new CliError(`cannot write the note's files to ${name}: not a directory`, EXIT.usage);
	}
}

/** Asks the password on the terminal, after what the reader should know first. */
function askReadPassword(io: Io, notices: ReadonlyArray<string>): Promise<string> {
	return withTerminal(io, (terminal) => {
		for (const notice of notices) {
			terminal.write(`${notice}\n`);
		}
		return askPassword(terminal, io.signal);
	});
}

/** What the reader should know before typing a password. */
function noticesOf(format1: boolean, attemptsLeft: number | undefined): string[] {
	if (!format1) {
		return ["A wrong password spends a read of this note: its format cannot check it first."];
	}
	return attemptsLeft === 1
		? ["The note takes one more wrong password: the next one deletes it."]
		: [];
}

function attempts(count: number): string {
	return count === 1 ? "1 attempt" : `${count} attempts`;
}

interface Reading {
	readonly note: ReadNoteIntoResult;
	readonly written: ReadonlyArray<WrittenFile>;
}

/**
 * Reads the note into the directory. A wrong password of a format 1 note,
 * which spends no read, is asked again on the terminal while the note takes
 * attempts; given ahead of time, it fails.
 */
async function readInto(
	io: Io,
	client: NotesClient,
	link: NoteLink,
	info: ExistingNoteInfo,
	options: { readonly dir: string; readonly passwordFile: string | undefined },
	screen: Screen,
): Promise<Reading> {
	const format1 = info.envelope !== undefined;
	let attemptsLeft = info.passwordAttemptsLeft;
	const given = info.hasPassword ? await givenPassword(io, options.passwordFile) : undefined;
	const asks = info.hasPassword && given === undefined;
	let password = asks ? await askReadPassword(io, noticesOf(format1, attemptsLeft)) : given;

	for (;;) {
		const out = (io.createOutputDirectory ?? createOutputDirectory)(options.dir);
		try {
			const note = await client.readNoteInto(link.id, link.keyFragment, {
				...(password === undefined ? {} : { password }),
				chunked: info.chunked,
				openFile: (file, index) => out.open(file, index),
				signal: io.signal,
				onProgress: (progress) => screen.progress(describeProgress(progress)),
			});
			return { note, written: out.written };
		} catch (err) {
			// Ctrl-C lands here too, as the read rejects with the signal's reason.
			await out.discard().catch((failure: unknown) => {
				// A `.part` file left behind is told, but the read's failure is the one to exit with.
				screen.done();
				writeLine(
					io.stderr,
					`secret: ${failure instanceof Error ? failure.message : String(failure)}`,
				);
			});
			if (!(err instanceof SecretDecryptionError)) {
				throw err;
			}
			if (!format1) {
				// A format 1 link to a note of format 0 is refused before it is read.
				throw formatOfLink(link) === 1 ? err : new CliError(FORMAT_0_REFUSED, EXIT.refused);
			}
			if (!asks) {
				throw err;
			}
			// A wrong password counts an attempt; a wrong link counts none, and
			// asking the password again would not mend it.
			const now = await client.checkNote(link.id, { signal: io.signal });
			if (!now.exists) {
				throw attemptsLeft === 1
					? new CliError(
							"wrong password: that was the last attempt, the note is deleted",
							EXIT.refused,
						)
					: err;
			}
			const left = now.passwordAttemptsLeft;
			if (left === undefined || attemptsLeft === undefined || left >= attemptsLeft) {
				throw err;
			}
			attemptsLeft = left;
			screen.done();
			password = await askReadPassword(io, [
				`Wrong password: ${attempts(left)} left.`,
				...noticesOf(format1, left),
			]);
		}
	}
}

/** Whether this read was the note's last. */
function wasLastRead(info: ExistingNoteInfo): boolean {
	if (info.maxReads === 0) {
		return false;
	}
	return info.readCount === undefined ? info.maxReads === 1 : info.maxReads - info.readCount <= 1;
}

export async function read(args: ReadonlyArray<string>, io: Io): Promise<void> {
	const { values, positionals } = parsing("read", () =>
		parseArgs({ args: [...args], options: OPTIONS, allowPositionals: true }),
	);
	const link = await linkToRead(positionals, io);
	const json = values.json === true;
	const screen = createScreen(io.stderr, values.quiet === true);
	const dir = resolve(io.cwd, values.out ?? ".");
	try {
		const client = await connect(io, link);
		const info = await client.checkNote(link.id, { signal: io.signal });
		if (!info.exists) {
			throw notFound();
		}
		// Before the read is spent: a directory asked for, or one the files need.
		if (values.out !== undefined || info.fileCount > 0) {
			await assertWritableDirectory(dir, values.out);
		}
		const { note, written } = await readInto(
			io,
			client,
			link,
			info,
			{ dir, passwordFile: values["password-file"] },
			screen,
		);
		screen.done();

		if (json) {
			writeJson(io.stdout, {
				text: note.text,
				contentMode: note.contentMode,
				files: written.map(({ name, path, type, size }) => ({ name, path, type, size })),
				createdAt: note.createdAt,
				expiresAt: note.expiresAt,
			});
			return;
		}
		if (note.text !== undefined) {
			writeText(io.stdout, note.text);
		}
		for (const file of written) {
			screen.info(`Saved ${file.path} (${formatSize(file.size)})`);
		}
		if (wasLastRead(info)) {
			screen.info("That was the note's last read: it is deleted.");
		}
	} catch (err) {
		throw translateError(err, { instance: link, namesNote: true });
	} finally {
		screen.done();
	}
}

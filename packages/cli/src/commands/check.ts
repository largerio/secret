import { parseArgs } from "node:util";
import type { ExistingNoteInfo } from "@largerio/secret-sdk";
import { notFound, translateError } from "../failures.js";
import { connect, noteOf } from "../instance.js";
import { COMMON_OPTIONS, linkArgument, parsing } from "../options.js";
import { writeJson, writeLine } from "../terminal.js";
import type { Io } from "../types.js";

function describePassword(info: ExistingNoteInfo): string {
	if (!info.hasPassword) {
		return "no";
	}
	if (info.passwordAttemptsLeft === undefined) {
		return "yes";
	}
	return info.passwordAttemptsLeft === 1
		? "yes, the next wrong one deletes the note"
		: `yes, ${info.passwordAttemptsLeft} wrong ones before the note is deleted`;
}

function describeReads(info: ExistingNoteInfo): string {
	if (info.maxReads === 0) {
		return "no limit";
	}
	if (info.readCount === undefined) {
		return `at most ${info.maxReads}`;
	}
	return `${info.maxReads - info.readCount} left of ${info.maxReads}`;
}

/** What is known of a note, from the instance, without spending a read. */
export async function check(args: ReadonlyArray<string>, io: Io): Promise<void> {
	const { values, positionals } = parsing("check", () =>
		parseArgs({ args: [...args], options: COMMON_OPTIONS, allowPositionals: true }),
	);
	const note = noteOf(linkArgument(positionals, "check"));
	try {
		const client = await connect(io, note);
		const info = await client.checkNote(note.id, { signal: io.signal });
		if (values.json === true) {
			writeJson(io.stdout, info);
		}
		if (!info.exists) {
			throw notFound();
		}
		if (values.json === true) {
			return;
		}
		for (const line of [
			`Password: ${describePassword(info)}`,
			`Files:    ${info.fileCount}`,
			`Expires:  ${info.expiresAt}`,
			`Reads:    ${describeReads(info)}`,
			`Format:   ${info.envelope === undefined ? 0 : 1}`,
		]) {
			writeLine(io.stdout, line);
		}
	} catch (err) {
		throw translateError(err, { instance: note, namesNote: true });
	}
}

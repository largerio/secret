import { parseArgs } from "node:util";
import { readApiKey } from "../credentials.js";
import { CliError, EXIT } from "../errors.js";
import { notFound, translateError } from "../failures.js";
import { assertKeyStaysPrivate, connect, noteOf, proofOfWork } from "../instance.js";
import { COMMON_OPTIONS, linkArgument, parsing } from "../options.js";
import { createScreen, writeJson } from "../terminal.js";
import type { Io } from "../types.js";

const OPTIONS = {
	...COMMON_OPTIONS,
	token: { type: "string" },
	"allow-http": { type: "boolean" },
} as const;

/** Deletes a note with its delete token: a write, let in by an API key or a proof of work. */
export async function deleteNote(args: ReadonlyArray<string>, io: Io): Promise<void> {
	const { values, positionals } = parsing("delete", () =>
		parseArgs({ args: [...args], options: OPTIONS, allowPositionals: true }),
	);
	const note = noteOf(linkArgument(positionals, "delete"));
	const token = values.token?.trim();
	if (!token) {
		throw new CliError(
			"give the note's delete token: secret delete <link> --token=<deleteToken>",
			EXIT.usage,
		);
	}
	const screen = createScreen(io.stderr, values.quiet === true);
	const apiKey = await readApiKey(io);
	if (apiKey !== undefined) {
		assertKeyStaysPrivate(note, values["allow-http"] === true);
	}
	try {
		const client = await connect(io, note, apiKey);
		// No proof of work for a note that is gone.
		const info = await client.checkNote(note.id, { signal: io.signal });
		if (!info.exists) {
			throw notFound();
		}
		const capToken = apiKey === undefined ? await proofOfWork(io, note, screen) : undefined;
		await client.deleteNote(note.id, token, capToken, { signal: io.signal });
		if (values.json === true) {
			writeJson(io.stdout, { deleted: true });
			return;
		}
		screen.info("The note is deleted.");
	} catch (err) {
		throw translateError(err, {
			instance: note,
			write: { apiKey: apiKey !== undefined },
			namesNote: true,
		});
	} finally {
		screen.done();
	}
}

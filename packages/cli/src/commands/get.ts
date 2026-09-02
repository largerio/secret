import { join } from "node:path";
import type { GetArgs } from "../args.js";
import { createClient } from "../client.js";
import { parseNoteRef, requireServer, resolveConnection } from "../config.js";
import { CliError, EXIT, UsageError } from "../errors.js";
import { formatBytes, safeFilename } from "../format.js";
import type { Io } from "../io.js";

/**
 * Where to save a file. By the time names are known the read is already
 * consumed — on a burn-after-read note, the only one — so an existing file
 * must never turn into a lost note: without --force, pick a numbered name
 * the way a browser download does.
 */
async function targetPath(io: Io, dir: string, name: string, force: boolean): Promise<string> {
	const wanted = join(dir, name);
	if (force || !(await io.fileExists(wanted))) return wanted;
	const dot = name.lastIndexOf(".");
	const stem = dot > 0 ? name.slice(0, dot) : name;
	const ext = dot > 0 ? name.slice(dot) : "";
	for (let n = 1; ; n += 1) {
		const candidate = join(dir, `${stem} (${String(n)})${ext}`);
		if (!(await io.fileExists(candidate))) return candidate;
	}
}

export async function get(args: GetArgs, io: Io): Promise<number> {
	const note = parseNoteRef(args.url, { needKey: true });
	const connection = resolveConnection(args, io.env, note.serverUrl);
	const serverUrl = requireServer(connection);
	const client = await createClient(serverUrl, connection.apiKey);

	// Reading consumes a read — on a burn-after-read note, the only one. Check
	// first so a missing password is caught while the note is still intact.
	const info = await client.checkNote(note.id);
	if (!info.exists) {
		throw new CliError("Note not found: it expired, was burned, or never existed");
	}
	if (info.hasPassword && args.password === undefined) {
		throw new UsageError(
			"This note is password-protected: pass --password <pw> (the note was left untouched)",
		);
	}

	const { payload } = await client.readNote(note.id, note.keyFragment, {
		chunked: info.chunked,
		...(args.password !== undefined ? { password: args.password } : {}),
	});

	if (payload.text !== undefined) {
		io.writeOut(payload.text);
		// A person expects the prompt on its own line; a pipe expects the bytes.
		if (io.stdoutIsTTY && !payload.text.endsWith("\n")) io.writeOut("\n");
	}

	const files = payload.files ?? [];
	if (files.length > 0) {
		const outDir = args.outDir ?? ".";
		await io.ensureDir(outDir);
		for (const file of files) {
			const target = await targetPath(io, outDir, safeFilename(file.name), args.force);
			await io.writeFile(target, file.data);
			io.writeErr(`Saved ${target} (${formatBytes(file.data.length)})\n`);
		}
	}

	return EXIT.ok;
}

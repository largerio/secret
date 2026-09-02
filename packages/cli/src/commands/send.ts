import { basename } from "node:path";
import type { SendArgs } from "../args.js";
import { createClient } from "../client.js";
import { requireApiKey, requireServer, resolveConnection } from "../config.js";
import { EXIT, UsageError } from "../errors.js";
import { mimeType } from "../format.js";
import type { Io } from "../io.js";

interface FileToSend {
	readonly name: string;
	readonly type: string;
	readonly data: Uint8Array;
}

async function collectText(args: SendArgs, io: Io): Promise<string | undefined> {
	if (args.text !== undefined) return args.text;
	// A terminal on stdin means nothing is piped in; anything else (a pipe, a
	// redirect, /dev/null under cron) is read to EOF.
	if (io.stdinIsTTY) return undefined;
	const bytes = await io.readStdin();
	if (bytes.length === 0) return undefined;
	return new TextDecoder().decode(bytes);
}

async function collectFiles(paths: readonly string[], io: Io): Promise<FileToSend[]> {
	const files: FileToSend[] = [];
	for (const path of paths) {
		const name = basename(path);
		files.push({ name, type: mimeType(name), data: await io.readFile(path) });
	}
	return files;
}

export async function send(args: SendArgs, io: Io): Promise<number> {
	const connection = resolveConnection(args, io.env);
	const serverUrl = requireServer(connection);
	// Fail before reading stdin or any file: a missing key is a configuration
	// problem, not something to discover after encrypting a 500 MB archive.
	const apiKey = requireApiKey(connection);

	const text = await collectText(args, io);
	const files = await collectFiles(args.files, io);
	if (text === undefined && files.length === 0) {
		throw new UsageError("Nothing to send: pass files, --text <text>, or pipe text on stdin");
	}

	const client = await createClient(serverUrl, apiKey);
	const result = await client.createNote({
		...(text !== undefined ? { text } : {}),
		...(files.length > 0 ? { files } : {}),
		...(args.password !== undefined ? { password: args.password } : {}),
		...(args.expiresIn !== undefined ? { expiresIn: args.expiresIn } : {}),
		...(args.maxReads !== undefined ? { maxReads: args.maxReads } : {}),
	});
	const url = client.buildShareUrl(result.id, result.keyFragment);

	if (args.json) {
		const json = {
			url,
			id: result.id,
			deleteToken: result.deleteToken,
			expiresAt: result.expiresAt,
		};
		io.writeOut(`${JSON.stringify(json)}\n`);
		return EXIT.ok;
	}

	// The URL alone on stdout, so `secret send | pbcopy` copies exactly that.
	io.writeOut(`${url}\n`);
	io.writeErr(`Delete token: ${result.deleteToken}\nExpires: ${result.expiresAt}\n`);
	return EXIT.ok;
}

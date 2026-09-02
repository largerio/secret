import type { CheckArgs } from "../args.js";
import { createClient } from "../client.js";
import { parseNoteRef, requireServer, resolveConnection } from "../config.js";
import { EXIT } from "../errors.js";
import type { Io } from "../io.js";

function describeReads(maxReads: number): string {
	if (maxReads === 0) return "unlimited";
	if (maxReads === 1) return "1 (burn after reading)";
	return `up to ${String(maxReads)}`;
}

export async function check(args: CheckArgs, io: Io): Promise<number> {
	const note = parseNoteRef(args.url, { needKey: false });
	const connection = resolveConnection(args, io.env, note.serverUrl);
	const client = await createClient(requireServer(connection), connection.apiKey);

	const info = await client.checkNote(note.id);

	if (args.json) {
		io.writeOut(`${JSON.stringify(info)}\n`);
		return info.exists ? EXIT.ok : EXIT.failure;
	}

	if (!info.exists) {
		io.writeErr("Note not found: it expired, was burned, or never existed\n");
		return EXIT.failure;
	}

	io.writeOut(
		[
			"Status:    available",
			`Password:  ${info.hasPassword ? "required" : "none"}`,
			`Files:     ${String(info.fileCount)}`,
			`Reads:     ${describeReads(info.maxReads)}`,
			`Expires:   ${info.expiresAt}`,
			"",
		].join("\n"),
	);
	return EXIT.ok;
}

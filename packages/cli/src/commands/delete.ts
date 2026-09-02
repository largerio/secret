import type { DeleteArgs } from "../args.js";
import { createClient } from "../client.js";
import { parseNoteRef, requireApiKey, requireServer, resolveConnection } from "../config.js";
import { EXIT } from "../errors.js";
import type { Io } from "../io.js";

export async function deleteNote(args: DeleteArgs, io: Io): Promise<number> {
	const note = parseNoteRef(args.url, { needKey: false });
	const connection = resolveConnection(args, io.env, note.serverUrl);
	const serverUrl = requireServer(connection);
	const apiKey = requireApiKey(connection);

	const client = await createClient(serverUrl, apiKey);
	await client.deleteNote(note.id, args.deleteToken);
	io.writeErr("Note deleted.\n");
	return EXIT.ok;
}

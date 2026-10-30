import { SECRETSTREAM_ABYTES } from "@largerio/secret-crypto/client";
import { isSizeClass } from "@largerio/secret-shared";
import { NoteError } from "./errors.js";

/**
 * Refuses a format 1 note whose messages, of these lengths in order, are not
 * those of a padded body (PROTOCOL.md, "Messages"): every message before the
 * last as long as the first, the last no longer and not empty, and the body
 * they hold, 17 bytes less each, a size class. Their lengths are all the
 * server sees of a body, and a reader leaves them to it.
 */
export function assertPadded(messageLengths: readonly number[]): void {
	const first = messageLengths[0] ?? 0;
	const last = messageLengths.at(-1) ?? 0;
	const evenCut = messageLengths.slice(0, -1).every((length) => length === first);
	const body = messageLengths.reduce((sum, length) => sum + length - SECRETSTREAM_ABYTES, 0);
	if (!evenCut || last > first || last <= SECRETSTREAM_ABYTES || !isSizeClass(body)) {
		throw new NoteError("note_not_padded");
	}
}

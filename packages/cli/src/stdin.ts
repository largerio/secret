import { CliError, EXIT } from "./errors.js";
import type { InputStream } from "./types.js";

/** The longest text a note holds, in UTF-16 code units (PROTOCOL.md, "Payload"). */
export const MAX_TEXT_LENGTH = 102_400;

/** The most UTF-8 bytes that many code units take: 3 each. */
const MAX_TEXT_BYTES = 3 * MAX_TEXT_LENGTH;

function tooLong(): CliError {
	return new CliError(
		`the text is longer than a note holds (${MAX_TEXT_LENGTH} characters): send it as a file`,
		EXIT.usage,
	);
}

/**
 * The text on stdin, to its end, exactly as it is: strict UTF-8, its BOM
 * kept. Reading stops past what a note can hold, so a large input is refused
 * without being loaded.
 */
export async function readText(stdin: InputStream, signal: AbortSignal): Promise<string> {
	const bytes = await readAtMost(stdin, MAX_TEXT_BYTES, signal);
	if (bytes === undefined) {
		throw tooLong();
	}
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		throw new CliError("stdin is not UTF-8 text: send it as a file", EXIT.usage);
	}
	if (text.length > MAX_TEXT_LENGTH) {
		throw tooLong();
	}
	return text;
}

/**
 * The bytes of `source` to its end, or undefined past `limit`. An abort
 * rejects at once, with the signal's reason, even while a read waits.
 */
async function readAtMost(
	source: InputStream,
	limit: number,
	signal: AbortSignal,
): Promise<Uint8Array | undefined> {
	signal.throwIfAborted();
	const iterator = source[Symbol.asyncIterator]();
	const { promise: aborted, reject } = Promise.withResolvers<never>();
	const onAbort = (): void => reject(signal.reason);
	signal.addEventListener("abort", onAbort, { once: true });
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const next = iterator.next();
			// Left pending by an abort: its outcome no longer matters.
			next.catch(() => undefined);
			const result = await Promise.race([next, aborted]);
			if (result.done === true) {
				return Buffer.concat(chunks);
			}
			size += result.value.length;
			if (size > limit) {
				return undefined;
			}
			chunks.push(result.value);
		}
	} finally {
		signal.removeEventListener("abort", onAbort);
		// Stops reading: on a terminal, it gives the input back.
		void iterator.return?.()?.catch(() => undefined);
	}
}

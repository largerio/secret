import { CliError, EXIT } from "./errors.js";
import { formatDuration } from "./units.js";

/*
 * What an instance answers, read as an instance that is not trusted could
 * answer: no further than a bound, and of its own words only those that look
 * like what they should be.
 */

/** The body as text, or undefined once it runs past `limit` bytes, where the read stops. */
export async function readBodyAtMost(
	response: Response,
	limit: number,
): Promise<string | undefined> {
	if (response.body === null) {
		return "";
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	let size = 0;

	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			return text + decoder.decode();
		}

		size += value.byteLength;
		if (size > limit) {
			await reader.cancel();
			return undefined;
		}

		text += decoder.decode(value, { stream: true });
	}
}

/** The text parsed as JSON, or undefined when it is not JSON. */
export function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** The fields of a JSON object, or undefined for any other value. */
export function recordOf(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}

	return value as Record<string, unknown>;
}

/** A problem's code as the instance names it (PROTOCOL.md, "Errors"), if it looks like one: it is shown. */
export function problemCodeOf(value: unknown): string | undefined {
	return typeof value === "string" && /^[a-z0-9_]{1,64}$/.test(value) ? value : undefined;
}

/** An instance that takes no more requests for now, and the seconds it asks to wait, if it says. */
export function rateLimited(
	origin: string,
	retryAfter: number | undefined,
	cause?: unknown,
): CliError {
	const wait = retryAfter === undefined ? "later" : `in ${formatDuration(Math.max(1, retryAfter))}`;
	return new CliError(
		`${origin} takes no more requests from this address for now: try again ${wait}`,
		EXIT.failure,
		{ cause },
	);
}

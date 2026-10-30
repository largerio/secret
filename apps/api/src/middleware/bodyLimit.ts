import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { problem } from "./problem.js";

/**
 * Limit for every request body that is not a note payload: /upload/init, Cap's
 * challenge, redeem and verify. They are all small JSON documents, parsed whole
 * into memory.
 */
export const DEFAULT_BODY_LIMIT = 64 * 1024;

export interface BodyLimits {
	/** JSON create and multipart upload: a whole encrypted note in one request. */
	readonly note: number;
	/** One secretstream chunk of a chunked upload. */
	readonly chunk: number;
}

const NOTE_PATHS = new Set(["/api/v1/notes", "/api/v1/notes/upload"]);
const CHUNK_PATH = /^\/api\/v1\/notes\/upload\/[^/]+\/chunks\/[^/]+$/;

/**
 * One body limit per request, chosen by path: large for the routes that carry a
 * note, small for everything else.
 *
 * Limits used to be opt-in, one exact path at a time, so any route left out had
 * none: an unauthenticated POST to /api/cap/redeem was read into memory whatever
 * its size, and a few gigabytes were enough to take the container down.
 */
export function createBodyLimits(limits: BodyLimits): MiddlewareHandler {
	const payloadTooLarge = (c: Context) => problem(c, 413, "payload_too_large", "Payload too large");

	const note = bodyLimit({ maxSize: limits.note, onError: payloadTooLarge });
	const chunk = bodyLimit({
		maxSize: limits.chunk,
		onError: (c) => problem(c, 413, "chunk_too_large", "Chunk too large"),
	});
	const other = bodyLimit({ maxSize: DEFAULT_BODY_LIMIT, onError: payloadTooLarge });

	return (c, next) => {
		const path = c.req.path;
		if (NOTE_PATHS.has(path)) return note(c, next);
		if (CHUNK_PATH.test(path)) return chunk(c, next);
		return other(c, next);
	};
}

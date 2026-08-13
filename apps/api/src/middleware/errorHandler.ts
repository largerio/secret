import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { type Logger, log } from "../logger.js";
import { matchedRoute } from "./requestContext.js";

export interface ErrorHandlerOptions {
	readonly debug: boolean;
	readonly logger?: Logger;
}

export interface ErrorLogPayload {
	readonly name?: string;
	readonly raw?: string;
}

// Strips every field that can carry sensitive context: err.message (often
// contains user input or internal paths), err.stack (file paths), err.cause
// and any other enumerable property. Operators correlate issues via the
// errorId returned to the client — for raw error inspection, run the API with
// DEBUG=true.
export function sanitizeError(err: unknown): ErrorLogPayload {
	if (err instanceof Error) {
		return { name: err.name };
	}
	return { raw: typeof err === "string" ? "string" : typeof err };
}

export function createErrorHandler(
	options: ErrorHandlerOptions,
): (err: Error, c: Context) => Response {
	const logger = options.logger ?? log;
	return (err, c) => {
		const requestId = c.get("requestId") as string | undefined;

		if (err instanceof HTTPException) {
			// HTTPExceptions are deliberate, client-safe responses, so they are not
			// logged by default. When one carries a `cause` (e.g. the real
			// decryption error behind a generic 500), surface it under DEBUG only.
			if (options.debug && err.cause !== undefined) {
				logger.error("http exception", {
					requestId,
					status: err.status,
					message: err.message,
					cause: err.cause,
				});
			}
			return c.json({ error: err.message }, err.status);
		}

		// The errorId is returned to the client AND logged next to the requestId,
		// so either identifier leads back to this line — and through requestId to
		// the request log entry it belongs to.
		const errorId = randomUUID();
		logger.error("unhandled error", {
			requestId,
			errorId,
			method: c.req.method,
			route: matchedRoute(c),
			...(options.debug ? { error: err } : sanitizeError(err)),
		});
		return c.json({ error: "Internal server error", errorId }, 500);
	};
}

import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";

export interface ErrorHandlerOptions {
	readonly debug: boolean;
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
	return (err, c) => {
		if (err instanceof HTTPException) {
			// HTTPExceptions are deliberate, client-safe responses, so they are not
			// logged by default. When one carries a `cause` (e.g. the real
			// decryption error behind a generic 500), surface it under DEBUG only.
			if (options.debug && err.cause !== undefined) {
				console.error(`[error] ${err.status} ${err.message}:`, err.cause);
			}
			return c.json({ error: err.message }, err.status);
		}
		const errorId = randomUUID();
		if (options.debug) {
			console.error(`[error] ${errorId}:`, err);
		} else {
			console.error(`[error] ${errorId}:`, sanitizeError(err));
		}
		return c.json({ error: "Internal server error", errorId }, 500);
	};
}

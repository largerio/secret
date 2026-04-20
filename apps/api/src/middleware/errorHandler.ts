import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";

export interface ErrorHandlerOptions {
	readonly debug: boolean;
}

export interface ErrorLogPayload {
	readonly name?: string;
	readonly message?: string;
	readonly stack?: string;
	readonly raw?: string;
}

export function sanitizeError(err: unknown): ErrorLogPayload {
	if (err instanceof Error) {
		return {
			name: err.name,
			message: err.message,
			...(err.stack !== undefined ? { stack: err.stack } : {}),
		};
	}
	return { raw: String(err) };
}

export function createErrorHandler(
	options: ErrorHandlerOptions,
): (err: Error, c: Context) => Response {
	return (err, c) => {
		if (err instanceof HTTPException) {
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

import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { type Logger, log } from "../logger.js";
import { codeOfStatus, ProblemException, problem } from "./problem.js";
import { matchedRoute } from "./requestContext.js";

export interface ErrorHandlerOptions {
	readonly debug: boolean;
	readonly logger?: Logger;
	/**
	 * Turns an error a module raises in its own terms (a refusal of the notes
	 * service, say) into the HTTP error it answers; undefined for any other.
	 */
	readonly toHttpException?: (err: Error) => HTTPException | undefined;
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
	return (thrown, c) => {
		const requestId = c.get("requestId") as string | undefined;
		const err = options.toHttpException?.(thrown) ?? thrown;
		const code = (exception: HTTPException) =>
			exception instanceof ProblemException ? exception.code : codeOfStatus(exception.status);

		if (err instanceof HTTPException && err.status !== 500) {
			// A refusal, an instance out of space (507) included: deliberate and
			// client-safe, so not logged. Under DEBUG, a cause it carries is.
			if (options.debug && err.cause !== undefined) {
				logger.error("http exception", {
					requestId,
					status: err.status,
					message: err.message,
					cause: err.cause,
				});
			}
			return problem(c, err.status, code(err), err.message);
		}

		// The errorId is returned to the client AND logged next to the requestId,
		// so either identifier leads back to this line — and through requestId to
		// the request log entry it belongs to.
		const errorId = randomUUID();

		if (err instanceof HTTPException) {
			// A failure on the server's side behind a client-safe message (a note
			// that does not open, say): logged like any other, its cause, which may
			// say more than a log should, under DEBUG only.
			logger.error("http exception", {
				requestId,
				errorId,
				status: err.status,
				method: c.req.method,
				route: matchedRoute(c),
				message: err.message,
				...(options.debug && err.cause !== undefined ? { cause: err.cause } : {}),
			});
			return problem(c, err.status, code(err), err.message, { errorId });
		}

		logger.error("unhandled error", {
			requestId,
			errorId,
			method: c.req.method,
			route: matchedRoute(c),
			...(options.debug ? { error: err } : sanitizeError(err)),
		});
		return problem(c, 500, "internal_error", "Internal server error", { errorId });
	};
}

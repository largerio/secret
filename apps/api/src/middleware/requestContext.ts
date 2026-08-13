import { randomUUID } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import type { Logger } from "../logger.js";

interface RequestIdEnv {
	Variables: {
		requestId: string;
	};
}

/**
 * Assign every request a fresh id, exposed to handlers via `c.get("requestId")`
 * and echoed in the X-Request-Id response header, so a client-reported failure
 * can be matched to its server-side log lines. The id is always generated
 * server-side: honouring a client-supplied one would let callers inject
 * arbitrary content into the logs.
 */
export function createRequestId(): MiddlewareHandler<RequestIdEnv> {
	return async (c, next) => {
		const id = randomUUID();
		c.set("requestId", id);
		c.header("X-Request-Id", id);
		await next();
	};
}

/**
 * The route *pattern* (`/api/v1/notes/:id`), never the raw path: note and
 * upload ids are capability-adjacent metadata that do not belong in logs.
 * Falls back to the wildcard middleware pattern for unrouted paths (404s).
 */
export function matchedRoute(c: Context): string {
	return c.req.matchedRoutes.at(-1)?.path ?? "*";
}

/** One structured line per request: id, method, route, status, duration. */
export function createRequestLogger(
	logger: Logger,
	options?: { readonly skipPaths?: readonly string[] },
): MiddlewareHandler<RequestIdEnv> {
	const skip = new Set(options?.skipPaths ?? []);
	return async (c, next) => {
		if (skip.has(c.req.path)) {
			await next();
			return;
		}

		const start = performance.now();
		await next();

		logger.info("request", {
			requestId: c.get("requestId"),
			method: c.req.method,
			route: matchedRoute(c),
			status: c.res.status,
			durationMs: Math.round(performance.now() - start),
		});
	};
}

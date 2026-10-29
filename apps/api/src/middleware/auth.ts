import { verifyApiKeyBuffers } from "@largerio/secret-shared/auth";
import type { MiddlewareHandler } from "hono";
import { cap } from "../routes/cap.js";

/**
 * Write authentication (PROTOCOL.md): an API key the operator configured, or a
 * single-use proof-of-work token. Attached to the routes that need it
 * (routes/notes/writes.ts), it refuses every request that reaches it without
 * one: which requests those are is the routes' to say, not a path's.
 */
export function createWriteAuth(apiKeys: ReadonlyArray<string>): MiddlewareHandler {
	const apiKeyBuffers: ReadonlyArray<Buffer> = apiKeys.map((k) => Buffer.from(k));

	return async (c, next) => {
		// Use a single generic message for every failure path so a caller cannot
		// probe which auth method (API key vs PoW token) a route expects.
		const authHeader = c.req.header("authorization");
		if (authHeader) {
			const key = authHeader.replace(/^Bearer\s+/i, "");
			if (verifyApiKeyBuffers(key, apiKeyBuffers)) {
				await next();
				return;
			}

			return c.json({ error: "Unauthorized" }, 401);
		}

		const capToken = c.req.header("x-cap-token");
		if (!capToken) {
			return c.json({ error: "Unauthorized" }, 401);
		}

		// keepToken: false makes the PoW token single-use (replay protection).
		const { success } = await cap.validateToken(capToken, { keepToken: false });
		if (!success) {
			return c.json({ error: "Unauthorized" }, 401);
		}

		await next();
	};
}

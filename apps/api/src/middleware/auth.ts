import { verifyApiKeyBuffers } from "@secret/shared/auth";
import type { MiddlewareHandler } from "hono";
import { cap } from "../routes/cap.js";

export function createWriteAuth(apiKeys: ReadonlyArray<string>): MiddlewareHandler {
	const apiKeyBuffers: ReadonlyArray<Buffer> = apiKeys.map((k) => Buffer.from(k));

	return async (c, next) => {
		const method = c.req.method;
		if (method !== "POST" && method !== "DELETE") {
			await next();
			return;
		}

		// Chunked upload session routes are authenticated by uploadId (init validates auth)
		const path = c.req.path;
		if (path.includes("/upload/") && (path.includes("/chunks/") || path.endsWith("/complete"))) {
			await next();
			return;
		}

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

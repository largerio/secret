import { verifyApiKey } from "@secret/shared/auth";
import type { MiddlewareHandler } from "hono";
import { cap } from "../routes/cap.js";

export function createWriteAuth(apiKeys: ReadonlyArray<string>): MiddlewareHandler {
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

		const authHeader = c.req.header("authorization");
		if (authHeader) {
			const key = authHeader.replace(/^Bearer\s+/i, "");
			if (verifyApiKey(key, apiKeys)) {
				await next();
				return;
			}

			return c.json({ error: "Invalid API key" }, 401);
		}

		const capToken = c.req.header("x-cap-token");
		if (!capToken) {
			return c.json({ error: "PoW token required" }, 401);
		}

		const { success } = await cap.validateToken(capToken);
		if (!success) {
			return c.json({ error: "Invalid PoW token" }, 401);
		}

		await next();
	};
}

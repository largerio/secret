import type { MiddlewareHandler, Context } from "hono";

interface RateLimitStore {
	readonly hits: number;
	readonly resetAt: number;
}

const MAX_STORE_SIZE = 10_000;

export function createRateLimit(options: {
	readonly windowMs: number;
	readonly max: number;
}): MiddlewareHandler {
	const store = new Map<string, RateLimitStore>();

	setInterval(() => {
		const now = Date.now();
		for (const [key, entry] of store) {
			if (entry.resetAt <= now) {
				store.delete(key);
			}
		}
	}, options.windowMs);

	return async (c: Context, next) => {
		const ip = c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "unknown";
		const now = Date.now();
		const existing = store.get(ip);

		if (existing === undefined || existing.resetAt <= now) {
			if (store.size >= MAX_STORE_SIZE && existing === undefined) {
				return c.json({ error: "Too many requests" }, 429);
			}
			store.set(ip, { hits: 1, resetAt: now + options.windowMs });
			await next();
			return;
		}

		if (existing.hits >= options.max) {
			return c.json({ error: "Too many requests" }, 429);
		}

		store.set(ip, { hits: existing.hits + 1, resetAt: existing.resetAt });
		await next();
	};
}

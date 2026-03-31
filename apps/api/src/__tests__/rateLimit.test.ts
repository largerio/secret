import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createRateLimit } from "../middleware/rateLimit.js";

describe("createRateLimit", () => {
	it("allows requests under the limit", async () => {
		const app = new Hono();
		const rl = createRateLimit({ windowMs: 60_000, max: 5 });
		app.use("*", rl.middleware);
		app.get("/test", (c) => c.json({ ok: true }));

		const res = await app.request("/test");
		expect(res.status).toBe(200);
		rl.cleanup();
	});

	it("returns 429 when limit is exceeded", async () => {
		const app = new Hono();
		const rl = createRateLimit({ windowMs: 60_000, max: 2 });
		app.use("*", rl.middleware);
		app.get("/test", (c) => c.json({ ok: true }));

		await app.request("/test");
		await app.request("/test");
		const res = await app.request("/test");
		expect(res.status).toBe(429);
		const json = await res.json();
		expect(json.error).toBe("Too many requests");
		rl.cleanup();
	});

	it("resets after window expires", async () => {
		const app = new Hono();
		const rl = createRateLimit({ windowMs: 100, max: 1 });
		app.use("*", rl.middleware);
		app.get("/test", (c) => c.json({ ok: true }));

		await app.request("/test");
		const blocked = await app.request("/test");
		expect(blocked.status).toBe(429);

		await new Promise((resolve) => setTimeout(resolve, 150));
		const res = await app.request("/test");
		expect(res.status).toBe(200);
		rl.cleanup();
	});

	it("tracks different IPs separately", async () => {
		const app = new Hono();
		const rl = createRateLimit({ windowMs: 60_000, max: 1 });
		app.use("*", rl.middleware);
		app.get("/test", (c) => c.json({ ok: true }));

		const res1 = await app.request("/test", { headers: { "X-Forwarded-For": "1.1.1.1" } });
		expect(res1.status).toBe(200);

		const res2 = await app.request("/test", { headers: { "X-Forwarded-For": "2.2.2.2" } });
		expect(res2.status).toBe(200);

		const res3 = await app.request("/test", { headers: { "X-Forwarded-For": "1.1.1.1" } });
		expect(res3.status).toBe(429);

		rl.cleanup();
	});

	it("uses first IP from X-Forwarded-For", async () => {
		const app = new Hono();
		const rl = createRateLimit({ windowMs: 60_000, max: 1 });
		app.use("*", rl.middleware);
		app.get("/test", (c) => c.json({ ok: true }));

		await app.request("/test", { headers: { "X-Forwarded-For": "1.1.1.1, 2.2.2.2" } });
		const res = await app.request("/test", { headers: { "X-Forwarded-For": "1.1.1.1, 3.3.3.3" } });
		expect(res.status).toBe(429);

		rl.cleanup();
	});

	it("falls back to X-Real-IP when X-Forwarded-For is absent", async () => {
		const app = new Hono();
		const rl = createRateLimit({ windowMs: 60_000, max: 1 });
		app.use("*", rl.middleware);
		app.get("/test", (c) => c.json({ ok: true }));

		await app.request("/test", { headers: { "X-Real-IP": "10.0.0.1" } });
		const res = await app.request("/test", { headers: { "X-Real-IP": "10.0.0.1" } });
		expect(res.status).toBe(429);

		rl.cleanup();
	});

	it("returns cleanup function that clears interval", () => {
		const rl = createRateLimit({ windowMs: 60_000, max: 5 });
		expect(typeof rl.cleanup).toBe("function");
		expect(() => rl.cleanup()).not.toThrow();
	});

	it("returns 429 response with correct error message", async () => {
		const app = new Hono();
		const rl = createRateLimit({ windowMs: 60_000, max: 1 });
		app.use("*", rl.middleware);
		app.get("/test", (c) => c.json({ ok: true }));

		await app.request("/test");
		const res = await app.request("/test");
		expect(res.status).toBe(429);
		const json = await res.json();
		expect(json).toEqual({ error: "Too many requests" });

		rl.cleanup();
	});
});

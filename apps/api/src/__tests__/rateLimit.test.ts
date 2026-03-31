import { Hono } from "hono";
import { describe, expect, it } from "vitest";
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

	it("cleanup interval removes expired entries", async () => {
		const rl = createRateLimit({ windowMs: 50, max: 100 });
		const app = new Hono();
		app.use("*", rl.middleware);
		app.get("/test", (c) => c.json({ ok: true }));

		// Make a request to populate the store
		await app.request("/test", { headers: { "X-Forwarded-For": "9.9.9.9" } });

		// Wait for the window to expire and the cleanup interval to fire
		await new Promise((resolve) => setTimeout(resolve, 120));

		// After cleanup, a new request from the same IP should work (entry was cleaned up)
		const res = await app.request("/test", { headers: { "X-Forwarded-For": "9.9.9.9" } });
		expect(res.status).toBe(200);

		rl.cleanup();
	});

	it("returns 429 when store exceeds MAX_STORE_SIZE for new IPs", async () => {
		const rl = createRateLimit({ windowMs: 60_000, max: 100 });
		const app = new Hono();
		app.use("*", rl.middleware);
		app.get("/test", (c) => c.json({ ok: true }));

		// Fill the store with 10,000 unique IPs
		for (let i = 0; i < 10_000; i++) {
			const ip = `${(i >> 24) & 255}.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
			await app.request("/test", { headers: { "X-Forwarded-For": ip } });
		}

		// A new IP should be rejected because the store is full
		const res = await app.request("/test", { headers: { "X-Forwarded-For": "255.255.255.255" } });
		expect(res.status).toBe(429);

		// An existing IP should still work (it already has an entry)
		const res2 = await app.request("/test", { headers: { "X-Forwarded-For": "0.0.0.0" } });
		expect(res2.status).toBe(200);

		rl.cleanup();
	});
});

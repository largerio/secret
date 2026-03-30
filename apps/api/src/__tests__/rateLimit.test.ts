import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createRateLimit } from "../middleware/rateLimit.js";

describe("createRateLimit", () => {
	it("allows requests under the limit", async () => {
		const app = new Hono();
		app.use("*", createRateLimit({ windowMs: 60_000, max: 5 }));
		app.get("/test", (c) => c.json({ ok: true }));

		const res = await app.request("/test");
		expect(res.status).toBe(200);
	});

	it("returns 429 when limit is exceeded", async () => {
		const app = new Hono();
		app.use("*", createRateLimit({ windowMs: 60_000, max: 2 }));
		app.get("/test", (c) => c.json({ ok: true }));

		await app.request("/test");
		await app.request("/test");
		const res = await app.request("/test");
		expect(res.status).toBe(429);
		const json = await res.json();
		expect(json.error).toBe("Too many requests");
	});

	it("resets after window expires", async () => {
		const app = new Hono();
		app.use("*", createRateLimit({ windowMs: 100, max: 1 }));
		app.get("/test", (c) => c.json({ ok: true }));

		await app.request("/test");
		const blocked = await app.request("/test");
		expect(blocked.status).toBe(429);

		await new Promise((resolve) => setTimeout(resolve, 150));
		const res = await app.request("/test");
		expect(res.status).toBe(200);
	});
});

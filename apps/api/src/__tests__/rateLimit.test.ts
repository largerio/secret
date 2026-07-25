import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
	buildTrustedBlockList,
	classifyNotesPath,
	createRateLimit,
} from "../middleware/rateLimit.js";

function mockEnv(remoteAddress: string): { incoming: { socket: { remoteAddress: string } } } {
	return { incoming: { socket: { remoteAddress } } };
}

describe("createRateLimit", () => {
	it("allows requests under the limit", async () => {
		const app = new Hono();
		const rl = createRateLimit({ windowMs: 60_000, max: 5 });
		app.use("*", rl.middleware);
		app.get("/test", (c) => c.json({ ok: true }));

		const res = await app.request("/test", {}, mockEnv("1.1.1.1"));
		expect(res.status).toBe(200);
		rl.cleanup();
	});

	it("returns 429 when limit is exceeded", async () => {
		const app = new Hono();
		const rl = createRateLimit({ windowMs: 60_000, max: 2 });
		app.use("*", rl.middleware);
		app.get("/test", (c) => c.json({ ok: true }));

		await app.request("/test", {}, mockEnv("1.1.1.1"));
		await app.request("/test", {}, mockEnv("1.1.1.1"));
		const res = await app.request("/test", {}, mockEnv("1.1.1.1"));
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

		await app.request("/test", {}, mockEnv("1.1.1.1"));
		const blocked = await app.request("/test", {}, mockEnv("1.1.1.1"));
		expect(blocked.status).toBe(429);

		await new Promise((resolve) => setTimeout(resolve, 150));
		const res = await app.request("/test", {}, mockEnv("1.1.1.1"));
		expect(res.status).toBe(200);
		rl.cleanup();
	});

	it("tracks different peer IPs separately", async () => {
		const app = new Hono();
		const rl = createRateLimit({ windowMs: 60_000, max: 1 });
		app.use("*", rl.middleware);
		app.get("/test", (c) => c.json({ ok: true }));

		const res1 = await app.request("/test", {}, mockEnv("1.1.1.1"));
		expect(res1.status).toBe(200);

		const res2 = await app.request("/test", {}, mockEnv("2.2.2.2"));
		expect(res2.status).toBe(200);

		const res3 = await app.request("/test", {}, mockEnv("1.1.1.1"));
		expect(res3.status).toBe(429);

		rl.cleanup();
	});

	it("ignores X-Forwarded-For when peer is not a trusted proxy", async () => {
		const app = new Hono();
		const rl = createRateLimit({ windowMs: 60_000, max: 1 });
		app.use("*", rl.middleware);
		app.get("/test", (c) => c.json({ ok: true }));

		await app.request("/test", { headers: { "X-Forwarded-For": "1.1.1.1" } }, mockEnv("9.9.9.9"));
		const res = await app.request(
			"/test",
			{ headers: { "X-Forwarded-For": "2.2.2.2" } },
			mockEnv("9.9.9.9"),
		);
		expect(res.status).toBe(429);

		rl.cleanup();
	});

	it("uses first IP from X-Forwarded-For when peer is trusted", async () => {
		const app = new Hono();
		const rl = createRateLimit({
			windowMs: 60_000,
			max: 1,
			trustedProxies: ["10.0.0.0/8"],
		});
		app.use("*", rl.middleware);
		app.get("/test", (c) => c.json({ ok: true }));

		await app.request(
			"/test",
			{ headers: { "X-Forwarded-For": "1.1.1.1, 2.2.2.2" } },
			mockEnv("10.0.0.5"),
		);
		const res = await app.request(
			"/test",
			{ headers: { "X-Forwarded-For": "1.1.1.1, 3.3.3.3" } },
			mockEnv("10.0.0.6"),
		);
		expect(res.status).toBe(429);

		rl.cleanup();
	});

	it("falls back to X-Real-IP when X-Forwarded-For is absent and peer is trusted", async () => {
		const app = new Hono();
		const rl = createRateLimit({
			windowMs: 60_000,
			max: 1,
			trustedProxies: ["127.0.0.1/32"],
		});
		app.use("*", rl.middleware);
		app.get("/test", (c) => c.json({ ok: true }));

		await app.request("/test", { headers: { "X-Real-IP": "10.0.0.1" } }, mockEnv("127.0.0.1"));
		const res = await app.request(
			"/test",
			{ headers: { "X-Real-IP": "10.0.0.1" } },
			mockEnv("127.0.0.1"),
		);
		expect(res.status).toBe(429);

		rl.cleanup();
	});

	it("ignores an invalid X-Forwarded-For and falls through to X-Real-IP", async () => {
		const app = new Hono();
		const rl = createRateLimit({
			windowMs: 60_000,
			max: 1,
			trustedProxies: ["10.0.0.0/8"],
		});
		app.use("*", rl.middleware);
		app.get("/test", (c) => c.json({ ok: true }));

		// Two different trusted peers send the same X-Real-IP but a garbage,
		// unparseable X-Forwarded-For. The bad XFF must be discarded so both
		// requests key on the shared X-Real-IP — the second is throttled.
		await app.request(
			"/test",
			{ headers: { "X-Forwarded-For": "not-an-ip", "X-Real-IP": "1.2.3.4" } },
			mockEnv("10.0.0.5"),
		);
		const res = await app.request(
			"/test",
			{ headers: { "X-Forwarded-For": "still-not-an-ip", "X-Real-IP": "1.2.3.4" } },
			mockEnv("10.0.0.6"),
		);
		expect(res.status).toBe(429);

		rl.cleanup();
	});

	it("falls back to peer IP when trusted proxy sends invalid forwarded headers", async () => {
		const app = new Hono();
		const rl = createRateLimit({
			windowMs: 60_000,
			max: 1,
			trustedProxies: ["127.0.0.1/32"],
		});
		app.use("*", rl.middleware);
		app.get("/test", (c) => c.json({ ok: true }));

		// Unparseable forwarded values must not create distinct buckets: a client
		// behind the proxy cannot spoof or churn keys with junk. Both requests key
		// on the peer IP, so the second is throttled.
		await app.request(
			"/test",
			{ headers: { "X-Forwarded-For": "garbage", "X-Real-IP": "also-garbage" } },
			mockEnv("127.0.0.1"),
		);
		const res = await app.request(
			"/test",
			{ headers: { "X-Forwarded-For": "different-garbage", "X-Real-IP": "more-garbage" } },
			mockEnv("127.0.0.1"),
		);
		expect(res.status).toBe(429);

		rl.cleanup();
	});

	it("falls back to peer IP when trusted proxy sends no forwarded headers", async () => {
		const app = new Hono();
		const rl = createRateLimit({
			windowMs: 60_000,
			max: 1,
			trustedProxies: ["127.0.0.1/32"],
		});
		app.use("*", rl.middleware);
		app.get("/test", (c) => c.json({ ok: true }));

		await app.request("/test", {}, mockEnv("127.0.0.1"));
		const res = await app.request("/test", {}, mockEnv("127.0.0.1"));
		expect(res.status).toBe(429);

		rl.cleanup();
	});

	it("bucket is shared when peer IP is missing (falls back to 'unknown')", async () => {
		const app = new Hono();
		const rl = createRateLimit({ windowMs: 60_000, max: 1 });
		app.use("*", rl.middleware);
		app.get("/test", (c) => c.json({ ok: true }));

		await app.request("/test");
		const res = await app.request("/test");
		expect(res.status).toBe(429);

		rl.cleanup();
	});

	it("treats invalid peer addresses as 'unknown'", async () => {
		const app = new Hono();
		const rl = createRateLimit({ windowMs: 60_000, max: 1 });
		app.use("*", rl.middleware);
		app.get("/test", (c) => c.json({ ok: true }));

		await app.request("/test", {}, mockEnv("not-an-ip"));
		const res = await app.request("/test", {}, mockEnv("::ffff:not-valid"));
		expect(res.status).toBe(429);

		rl.cleanup();
	});

	it("handles IPv4-mapped IPv6 peer addresses", async () => {
		const app = new Hono();
		const rl = createRateLimit({ windowMs: 60_000, max: 1 });
		app.use("*", rl.middleware);
		app.get("/test", (c) => c.json({ ok: true }));

		await app.request("/test", {}, mockEnv("::ffff:1.2.3.4"));
		const res = await app.request("/test", {}, mockEnv("1.2.3.4"));
		expect(res.status).toBe(429);

		rl.cleanup();
	});

	it("supports IPv6 trusted proxies", async () => {
		const app = new Hono();
		const rl = createRateLimit({
			windowMs: 60_000,
			max: 1,
			trustedProxies: ["2001:db8::/32"],
		});
		app.use("*", rl.middleware);
		app.get("/test", (c) => c.json({ ok: true }));

		await app.request(
			"/test",
			{ headers: { "X-Forwarded-For": "5.5.5.5" } },
			mockEnv("2001:db8::1"),
		);
		const res = await app.request(
			"/test",
			{ headers: { "X-Forwarded-For": "5.5.5.5" } },
			mockEnv("2001:db8::2"),
		);
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

		await app.request("/test", {}, mockEnv("1.1.1.1"));
		const res = await app.request("/test", {}, mockEnv("1.1.1.1"));
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

		await app.request("/test", {}, mockEnv("9.9.9.9"));
		await new Promise((resolve) => setTimeout(resolve, 120));
		const res = await app.request("/test", {}, mockEnv("9.9.9.9"));
		expect(res.status).toBe(200);

		rl.cleanup();
	});

	it("cleanup interval keeps non-expired entries", async () => {
		const rl = createRateLimit({ windowMs: 50, max: 100 });
		const app = new Hono();
		app.use("*", rl.middleware);
		app.get("/test", (c) => c.json({ ok: true }));

		await app.request("/test", {}, mockEnv("8.8.8.8"));
		await new Promise((resolve) => setTimeout(resolve, 70));
		await app.request("/test", {}, mockEnv("7.7.7.7"));
		await new Promise((resolve) => setTimeout(resolve, 60));
		const res = await app.request("/test", {}, mockEnv("8.8.8.8"));
		expect(res.status).toBe(200);

		rl.cleanup();
	});

	it("evicts expired entry when store is full and new IP arrives", async () => {
		const rl = createRateLimit({ windowMs: 60_000, max: 100 });
		const app = new Hono();
		app.use("*", rl.middleware);
		app.get("/test", (c) => c.json({ ok: true }));

		for (let i = 0; i < 10_000; i++) {
			const ip = `${(i >> 24) & 255}.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
			await app.request("/test", {}, mockEnv(ip));
		}

		const originalNow = Date.now;
		Date.now = () => originalNow() + 120_000;

		try {
			const res = await app.request("/test", {}, mockEnv("255.255.255.255"));
			expect(res.status).toBe(200);
		} finally {
			Date.now = originalNow;
		}

		rl.cleanup();
	});

	it("returns 429 when store exceeds MAX_STORE_SIZE for new IPs", async () => {
		const rl = createRateLimit({ windowMs: 60_000, max: 100 });
		const app = new Hono();
		app.use("*", rl.middleware);
		app.get("/test", (c) => c.json({ ok: true }));

		for (let i = 0; i < 10_000; i++) {
			const ip = `${(i >> 24) & 255}.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
			await app.request("/test", {}, mockEnv(ip));
		}

		const res = await app.request("/test", {}, mockEnv("255.255.255.255"));
		expect(res.status).toBe(429);

		const res2 = await app.request("/test", {}, mockEnv("0.0.0.0"));
		expect(res2.status).toBe(200);

		rl.cleanup();
	});
});

describe("buildTrustedBlockList", () => {
	it("returns empty list for no CIDRs", () => {
		const list = buildTrustedBlockList([]);
		expect(list.check("1.2.3.4", "ipv4")).toBe(false);
	});

	it("accepts exact IPv4 addresses", () => {
		const list = buildTrustedBlockList(["127.0.0.1"]);
		expect(list.check("127.0.0.1", "ipv4")).toBe(true);
		expect(list.check("127.0.0.2", "ipv4")).toBe(false);
	});

	it("accepts IPv4 subnets", () => {
		const list = buildTrustedBlockList(["10.0.0.0/8"]);
		expect(list.check("10.1.2.3", "ipv4")).toBe(true);
		expect(list.check("11.0.0.1", "ipv4")).toBe(false);
	});

	it("accepts IPv6 subnets", () => {
		const list = buildTrustedBlockList(["2001:db8::/32"]);
		expect(list.check("2001:db8::1", "ipv6")).toBe(true);
		expect(list.check("2001:db9::1", "ipv6")).toBe(false);
	});

	it("ignores empty entries", () => {
		expect(() => buildTrustedBlockList(["", "  ", "1.1.1.1"])).not.toThrow();
	});

	it("throws on invalid address", () => {
		expect(() => buildTrustedBlockList(["not-an-ip"])).toThrow(/Invalid trusted proxy address/);
	});

	it("throws on invalid prefix", () => {
		expect(() => buildTrustedBlockList(["10.0.0.0/abc"])).toThrow(/Invalid trusted proxy prefix/);
	});

	it("throws on missing address", () => {
		expect(() => buildTrustedBlockList(["/24"])).toThrow(/Invalid trusted proxy entry/);
	});
});

describe("classifyNotesPath", () => {
	it.each([
		["/api/v1/notes", "create"],
		["/api/v1/notes/", "create"],
		["/api/v1/notes/upload", "create"],
		["/api/v1/notes/upload/init", "create"],
		["/api/v1/notes/aBcDeFgHiJkL/exists", "exists"],
		["/api/v1/notes/upload/abc123/chunks/0", "chunks"],
		["/api/v1/notes/upload/abc123/chunks/125", "chunks"],
		["/api/v1/notes/aBcDeFgHiJkL", "read"],
		["/api/v1/notes/aBcDeFgHiJkL/raw", "read"],
		["/api/v1/notes/aBcDeFgHiJkL/stream", "read"],
		["/api/v1/notes/upload/abc123/complete", "read"],
	])("classifies %s as %s", (path, expected) => {
		expect(classifyNotesPath(path)).toBe(expected);
	});

	it("keeps chunk uploads out of the tighter read bucket", () => {
		// Regression guard: chunk uploads previously matched the generic
		// `/notes/*` rule too, and the 60/min bound won — making a 125-chunk
		// (500 MB) upload impossible to complete.
		expect(classifyNotesPath("/api/v1/notes/upload/abc/chunks/61")).not.toBe("read");
	});

	it("bills the multipart create endpoint as a create, not a read", () => {
		expect(classifyNotesPath("/api/v1/notes/upload")).toBe("create");
	});
});

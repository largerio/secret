import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
	createCors,
	createDocsSecurityHeaders,
	createSecurityHeaders,
} from "../middleware/security.js";

describe("createSecurityHeaders", () => {
	it("adds security headers to responses", async () => {
		const app = new Hono();
		app.use("*", createSecurityHeaders());
		app.get("/test", (c) => c.json({ ok: true }));

		const res = await app.request("/test");
		expect(res.status).toBe(200);
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(res.headers.get("x-frame-options")).toBe("DENY");
		expect(res.headers.get("referrer-policy")).toBe("no-referrer");
		expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin");
		expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
	});

	it("sets content-security-policy header", async () => {
		const app = new Hono();
		app.use("*", createSecurityHeaders());
		app.get("/test", (c) => c.json({ ok: true }));

		const res = await app.request("/test");
		const csp = res.headers.get("content-security-policy");
		expect(csp).toBeDefined();
		expect(csp).toContain("default-src 'none'");
		expect(csp).toContain("script-src 'self'");
		expect(csp).toContain("frame-ancestors 'none'");
	});

	it("skips configured paths", async () => {
		const app = new Hono();
		app.use("*", createSecurityHeaders({ skipPaths: ["/skip"] }));
		app.get("/skip", (c) => c.json({ ok: true }));
		app.get("/keep", (c) => c.json({ ok: true }));

		const skipped = await app.request("/skip");
		expect(skipped.headers.get("content-security-policy")).toBeNull();

		const kept = await app.request("/keep");
		expect(kept.headers.get("content-security-policy")).toBeDefined();
	});
});

describe("createDocsSecurityHeaders", () => {
	it("sets a Scalar-compatible CSP that still blocks framing", async () => {
		const app = new Hono();
		app.use("/docs", createDocsSecurityHeaders());
		app.get("/docs", (c) => c.text("ok"));

		const res = await app.request("/docs");
		const csp = res.headers.get("content-security-policy");
		expect(csp).toContain("default-src 'none'");
		expect(csp).toContain("cdn.jsdelivr.net");
		expect(csp).toContain("frame-ancestors 'none'");
		expect(res.headers.get("x-frame-options")).toBe("DENY");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(res.headers.get("referrer-policy")).toBe("no-referrer");
	});

	it("preserves docs CSP when stacked with a strict middleware that skips /docs", async () => {
		const app = new Hono();
		app.use("/docs", createDocsSecurityHeaders());
		app.use("*", createSecurityHeaders({ skipPaths: ["/docs"] }));
		app.get("/docs", (c) => c.text("ok"));

		const res = await app.request("/docs");
		const csp = res.headers.get("content-security-policy");
		expect(csp).toContain("cdn.jsdelivr.net");
	});
});

describe("createCors", () => {
	it("sets CORS headers for allowed origins", async () => {
		const app = new Hono();
		app.use("*", createCors(["http://localhost:5173"]));
		app.get("/test", (c) => c.json({ ok: true }));

		const res = await app.request("/test", {
			headers: { Origin: "http://localhost:5173" },
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
	});

	it("handles preflight requests with correct methods and headers", async () => {
		const app = new Hono();
		app.use("*", createCors(["http://localhost:5173"]));
		app.get("/test", (c) => c.json({ ok: true }));

		const res = await app.request("/test", {
			method: "OPTIONS",
			headers: {
				Origin: "http://localhost:5173",
				"Access-Control-Request-Method": "POST",
				"Access-Control-Request-Headers": "Content-Type",
			},
		});
		const allowMethods = res.headers.get("access-control-allow-methods");
		expect(allowMethods).toContain("GET");
		expect(allowMethods).toContain("POST");
		expect(allowMethods).toContain("DELETE");
		const allowHeaders = res.headers.get("access-control-allow-headers");
		expect(allowHeaders).toContain("Content-Type");
		expect(allowHeaders).toContain("X-Delete-Token");
	});

	it("sets max-age header", async () => {
		const app = new Hono();
		app.use("*", createCors(["http://example.com"]));
		app.get("/test", (c) => c.json({ ok: true }));

		const res = await app.request("/test", {
			method: "OPTIONS",
			headers: {
				Origin: "http://example.com",
				"Access-Control-Request-Method": "GET",
			},
		});
		expect(res.headers.get("access-control-max-age")).toBe("86400");
	});
});

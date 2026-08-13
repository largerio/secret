import type { Context } from "hono";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createLogger, type LogLevel } from "../logger.js";
import {
	createRequestId,
	createRequestLogger,
	matchedRoute,
} from "../middleware/requestContext.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function makeApp() {
	const lines: Array<{ level: LogLevel; entry: Record<string, unknown> }> = [];
	const logger = createLogger({
		write: (level, line) => {
			lines.push({ level, entry: JSON.parse(line) as Record<string, unknown> });
		},
	});

	const app = new Hono<{ Variables: { requestId: string } }>();
	app.use("*", createRequestId());
	app.use("*", createRequestLogger(logger, { skipPaths: ["/api/health"] }));
	app.get("/notes/:id", (c) => c.json({ requestId: c.get("requestId") }));
	app.get("/api/health", (c) => c.json({ status: "ok" }));

	return { app, lines };
}

describe("createRequestId", () => {
	it("exposes a UUID in the context and echoes it in X-Request-Id", async () => {
		const { app } = makeApp();

		const res = await app.request("/notes/abc123");
		const header = res.headers.get("X-Request-Id");
		const body = (await res.json()) as { requestId: string };

		expect(header).toMatch(UUID_RE);
		expect(body.requestId).toBe(header);
	});

	it("generates a fresh id per request and ignores a client-supplied one", async () => {
		const { app } = makeApp();

		const first = await app.request("/notes/abc123", {
			headers: { "X-Request-Id": "spoofed-value" },
		});
		const second = await app.request("/notes/abc123");

		expect(first.headers.get("X-Request-Id")).not.toBe("spoofed-value");
		expect(first.headers.get("X-Request-Id")).not.toBe(second.headers.get("X-Request-Id"));
	});
});

describe("createRequestLogger", () => {
	it("logs one structured line per request with the route pattern, not the path", async () => {
		const { app, lines } = makeApp();

		const res = await app.request("/notes/super-secret-id");
		expect(res.status).toBe(200);

		expect(lines).toHaveLength(1);
		const entry = lines[0]?.entry as Record<string, unknown>;
		expect(entry).toMatchObject({
			level: "info",
			msg: "request",
			method: "GET",
			route: "/notes/:id",
			status: 200,
		});
		expect(entry["requestId"]).toBe(res.headers.get("X-Request-Id"));
		expect(entry["durationMs"]).toBeTypeOf("number");
		expect(JSON.stringify(entry)).not.toContain("super-secret-id");
	});

	it("logs 404s under the wildcard pattern", async () => {
		const { app, lines } = makeApp();

		const res = await app.request("/nowhere/xyz");
		expect(res.status).toBe(404);

		expect(lines).toHaveLength(1);
		expect(lines[0]?.entry).toMatchObject({ msg: "request", status: 404, route: "/*" });
		expect(JSON.stringify(lines[0]?.entry)).not.toContain("/nowhere/xyz");
	});

	it("skips configured paths so health probes do not drown the log", async () => {
		const { app, lines } = makeApp();

		const res = await app.request("/api/health");
		expect(res.status).toBe(200);
		expect(lines).toHaveLength(0);
	});

	it("logs every request when no skip list is configured", async () => {
		const lines: Array<Record<string, unknown>> = [];
		const logger = createLogger({
			write: (_level, line) => {
				lines.push(JSON.parse(line) as Record<string, unknown>);
			},
		});
		const app = new Hono<{ Variables: { requestId: string } }>();
		app.use("*", createRequestId());
		app.use("*", createRequestLogger(logger));
		app.get("/api/health", (c) => c.json({ status: "ok" }));

		await app.request("/api/health");
		expect(lines).toHaveLength(1);
	});
});

describe("matchedRoute", () => {
	it("falls back to the wildcard when nothing matched", () => {
		const bare = { req: { matchedRoutes: [] } } as unknown as Context;
		expect(matchedRoute(bare)).toBe("*");
	});
});

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createErrorHandler, sanitizeError } from "../middleware/errorHandler.js";
import { createRequestId } from "../middleware/requestContext.js";

describe("sanitizeError", () => {
	it("returns only the error name for Error instances", () => {
		const err = new TypeError("boom with /etc/secret");
		expect(sanitizeError(err)).toEqual({ name: "TypeError" });
	});

	it("does not leak message, stack, or extra properties", () => {
		const err = new Error("sensitive: /etc/passwd") as Error & { cause?: string };
		err.cause = "sensitive-cause";
		const payload = sanitizeError(err);
		expect(payload).not.toHaveProperty("message");
		expect(payload).not.toHaveProperty("stack");
		expect(payload).not.toHaveProperty("cause");
	});

	it("reports only the type for non-Error values", () => {
		expect(sanitizeError("oops")).toEqual({ raw: "string" });
		expect(sanitizeError(42)).toEqual({ raw: "number" });
		expect(sanitizeError(null)).toEqual({ raw: "object" });
	});
});

describe("createErrorHandler", () => {
	let consoleSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		// Restore first so each test starts from a fresh spy with no leaked call
		// history from a previous test in this block.
		vi.restoreAllMocks();
		consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	});

	function lastLogEntry(): Record<string, unknown> {
		const [line] = consoleSpy.mock.calls.at(-1) ?? [];
		return JSON.parse(line as string) as Record<string, unknown>;
	}

	it("returns HTTPException body and does not log", async () => {
		const app = new Hono();
		app.onError(createErrorHandler({ debug: false }));
		app.get("/x", () => {
			throw new HTTPException(418, { message: "teapot" });
		});

		const res = await app.request("/x");
		expect(res.status).toBe(418);
		expect(await res.json()).toEqual({ error: "teapot" });
		expect(consoleSpy).not.toHaveBeenCalled();
	});

	it("logs an HTTPException cause under debug while keeping the client message", async () => {
		const app = new Hono();
		app.onError(createErrorHandler({ debug: true }));
		const cause = new Error("real decryption failure");
		app.get("/x", () => {
			throw new HTTPException(500, { message: "Failed to decrypt note", cause });
		});

		const res = await app.request("/x");
		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ error: "Failed to decrypt note" });

		const entry = lastLogEntry();
		expect(entry["msg"]).toBe("http exception");
		expect(entry["status"]).toBe(500);
		expect(entry["message"]).toBe("Failed to decrypt note");
		expect(entry["cause"]).toMatchObject({ name: "Error", message: "real decryption failure" });
	});

	it("does not log an HTTPException without a cause under debug", async () => {
		const app = new Hono();
		app.onError(createErrorHandler({ debug: true }));
		app.get("/x", () => {
			throw new HTTPException(404, { message: "Note not found" });
		});

		const res = await app.request("/x");
		expect(res.status).toBe(404);
		expect(consoleSpy).not.toHaveBeenCalled();
	});

	it("logs sanitized payload by default and returns 500 + errorId", async () => {
		const app = new Hono();
		app.onError(createErrorHandler({ debug: false }));
		app.get("/x", () => {
			const err = new Error("leak: /etc/secret") as Error & { cause?: string };
			err.cause = "sensitive-cause";
			throw err;
		});

		const res = await app.request("/x");
		expect(res.status).toBe(500);
		const body = (await res.json()) as { error: string; errorId: string };
		expect(body.error).toBe("Internal server error");
		expect(body.errorId).toMatch(/^[0-9a-f-]{36}$/);

		expect(consoleSpy).toHaveBeenCalledTimes(1);
		const entry = lastLogEntry();
		expect(entry["msg"]).toBe("unhandled error");
		expect(entry["errorId"]).toBe(body.errorId);
		expect(entry["route"]).toBe("/x");
		expect(entry["name"]).toBe("Error");
		expect(JSON.stringify(entry)).not.toContain("leak:");
		expect(JSON.stringify(entry)).not.toContain("sensitive-cause");
	});

	it("logs the full error object when debug is enabled", async () => {
		const app = new Hono();
		app.onError(createErrorHandler({ debug: true }));
		const raw = new Error("debug-me");
		app.get("/x", () => {
			throw raw;
		});

		const res = await app.request("/x");
		expect(res.status).toBe(500);

		const entry = lastLogEntry();
		expect(entry["error"]).toMatchObject({ name: "Error", message: "debug-me" });
		expect((entry["error"] as { stack?: string }).stack).toBeDefined();
	});

	it("correlates the log line with the request id", async () => {
		const app = new Hono();
		app.onError(createErrorHandler({ debug: false }));
		app.use("*", createRequestId());
		app.get("/x", () => {
			throw new Error("boom");
		});

		const res = await app.request("/x");
		expect(res.status).toBe(500);

		const entry = lastLogEntry();
		expect(entry["requestId"]).toBe(res.headers.get("X-Request-Id"));
	});
});

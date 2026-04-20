import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createErrorHandler, sanitizeError } from "../middleware/errorHandler.js";

describe("sanitizeError", () => {
	it("extracts name/message/stack from Error", () => {
		const err = new TypeError("boom");
		const payload = sanitizeError(err);
		expect(payload.name).toBe("TypeError");
		expect(payload.message).toBe("boom");
		expect(payload.stack).toBeDefined();
		expect(payload.raw).toBeUndefined();
	});

	it("falls back to String() for non-Error values", () => {
		expect(sanitizeError("oops")).toEqual({ raw: "oops" });
		expect(sanitizeError(42)).toEqual({ raw: "42" });
		expect(sanitizeError(null)).toEqual({ raw: "null" });
	});

	it("omits stack when it is undefined", () => {
		const err = new Error("no stack");
		Object.defineProperty(err, "stack", { value: undefined });
		expect(sanitizeError(err)).toEqual({ name: "Error", message: "no stack" });
	});
});

describe("createErrorHandler", () => {
	let consoleSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	});

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
		const [, payload] = consoleSpy.mock.calls[0] ?? [];
		expect(payload).toMatchObject({
			name: "Error",
			message: "leak: /etc/secret",
		});
		expect(payload).not.toHaveProperty("cause");
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

		expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("[error]"), raw);
	});
});

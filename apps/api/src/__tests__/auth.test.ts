import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createWriteAuth } from "../middleware/auth.js";

vi.mock("../routes/cap.js", () => ({
	cap: {
		validateToken: vi.fn((token: string) =>
			Promise.resolve({ success: token === "valid-cap-token" }),
		),
	},
}));

describe("createWriteAuth", () => {
	it("passes through GET requests without auth", async () => {
		const app = new Hono();
		app.use("*", createWriteAuth([]));
		app.get("/test", (c) => c.json({ ok: true }));

		const res = await app.request("/test");
		expect(res.status).toBe(200);
	});

	it("rejects POST without Cap token or API key", async () => {
		const app = new Hono();
		app.use("*", createWriteAuth([]));
		app.post("/test", (c) => c.json({ ok: true }));

		const res = await app.request("/test", { method: "POST" });
		expect(res.status).toBe(401);
		const json = await res.json();
		expect(json.error).toBe("Unauthorized");
	});

	it("rejects DELETE without Cap token or API key", async () => {
		const app = new Hono();
		app.use("*", createWriteAuth([]));
		app.delete("/test", (c) => c.json({ ok: true }));

		const res = await app.request("/test", { method: "DELETE" });
		expect(res.status).toBe(401);
	});

	it("accepts valid API key", async () => {
		const app = new Hono();
		app.use("*", createWriteAuth(["my-key"]));
		app.post("/test", (c) => c.json({ ok: true }));

		const res = await app.request("/test", {
			method: "POST",
			headers: { Authorization: "Bearer my-key" },
		});
		expect(res.status).toBe(200);
	});

	it("rejects invalid API key", async () => {
		const app = new Hono();
		app.use("*", createWriteAuth(["my-key"]));
		app.post("/test", (c) => c.json({ ok: true }));

		const res = await app.request("/test", {
			method: "POST",
			headers: { Authorization: "Bearer wrong-key" },
		});
		expect(res.status).toBe(401);
		const json = await res.json();
		expect(json.error).toBe("Unauthorized");
	});

	it("accepts valid Cap token", async () => {
		const app = new Hono();
		app.use("*", createWriteAuth([]));
		app.post("/test", (c) => c.json({ ok: true }));

		const res = await app.request("/test", {
			method: "POST",
			headers: { "X-Cap-Token": "valid-cap-token" },
		});
		expect(res.status).toBe(200);
	});

	it("rejects invalid Cap token", async () => {
		const app = new Hono();
		app.use("*", createWriteAuth([]));
		app.post("/test", (c) => c.json({ ok: true }));

		const res = await app.request("/test", {
			method: "POST",
			headers: { "X-Cap-Token": "invalid-token" },
		});
		expect(res.status).toBe(401);
		const json = await res.json();
		expect(json.error).toBe("Unauthorized");
	});

	it("accepts an API key with a lowercase bearer scheme", async () => {
		const app = new Hono();
		app.use("*", createWriteAuth(["my-key"]));
		app.post("/test", (c) => c.json({ ok: true }));

		const res = await app.request("/test", {
			method: "POST",
			headers: { Authorization: "bearer my-key" },
		});
		expect(res.status).toBe(200);
	});

	it("prefers API key over Cap token", async () => {
		const app = new Hono();
		app.use("*", createWriteAuth(["my-key"]));
		app.post("/test", (c) => c.json({ ok: true }));

		const res = await app.request("/test", {
			method: "POST",
			headers: { Authorization: "Bearer my-key", "X-Cap-Token": "invalid-token" },
		});
		expect(res.status).toBe(200);
	});
});

// `{ keepToken: false }` is the ONLY thing preventing a solved Proof-of-Work
// token from being replayed forever. Every mock in the suite ignored the second
// argument, so dropping that option left all tests green while turning the PoW
// gate into "pay once, write forever".
describe("Proof-of-Work token replay", () => {
	it("consumes the token (keepToken: false) so it cannot be replayed", async () => {
		const { cap } = await import("../routes/cap.js");
		const validateToken = vi.mocked(cap.validateToken);
		validateToken.mockClear();

		const app = new Hono();
		app.use("*", createWriteAuth([]));
		app.post("/test", (c) => c.json({ ok: true }));

		await app.request("/test", {
			method: "POST",
			headers: { "X-Cap-Token": "valid-cap-token" },
		});

		expect(validateToken).toHaveBeenCalledWith("valid-cap-token", { keepToken: false });
	});

	it("rejects the second use of a single-use token", async () => {
		const { cap } = await import("../routes/cap.js");
		const validateToken = vi.mocked(cap.validateToken);

		// Stateful stand-in for cap.js: honours keepToken the way the real
		// implementation does, so a replay actually fails.
		const spent = new Set<string>();
		validateToken.mockImplementation((token, conf) => {
			const success = token === "valid-cap-token" && !spent.has(token);
			if (success && conf?.keepToken !== true) spent.add(token);
			return Promise.resolve({ success });
		});

		const app = new Hono();
		app.use("*", createWriteAuth([]));
		app.post("/test", (c) => c.json({ ok: true }));

		const headers = { "X-Cap-Token": "valid-cap-token" };
		const first = await app.request("/test", { method: "POST", headers });
		const second = await app.request("/test", { method: "POST", headers });

		expect(first.status).toBe(200);
		expect(second.status).toBe(401);

		validateToken.mockImplementation((token) =>
			Promise.resolve({ success: token === "valid-cap-token" }),
		);
	});
});

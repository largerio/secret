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

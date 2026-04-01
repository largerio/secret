import { describe, expect, it } from "vitest";
import { createCapRoutes } from "../routes/cap.js";

const app = createCapRoutes();

const mockCap = {
	createChallenge: async () => ({
		challenge: { c: 50, s: 32, d: 4 },
		token: "mock-token",
		expires: Date.now() + 600_000,
	}),
	redeemChallenge: async ({ token }: { token: string; solutions: number[] }) => {
		if (token === "valid-token") {
			return { success: true, token: "redeemed-token", expires: Date.now() + 1200_000 };
		}

		return { success: false, message: "Challenge invalid or expired" };
	},
	validateToken: async (token: string) => ({
		success: token === "redeemed-token",
	}),
};

// biome-ignore lint/suspicious/noExplicitAny: test mock
const mockApp = createCapRoutes(mockCap as any);

describe("POST /challenge", () => {
	it("returns a challenge with token and config", async () => {
		const res = await app.request("/challenge", { method: "POST" });
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.challenge).toBeDefined();
		expect(json.challenge.c).toBe(50);
		expect(json.challenge.s).toBe(32);
		expect(json.challenge.d).toBe(4);
		expect(json.token).toBeDefined();
		expect(json.expires).toBeDefined();
	});
});

describe("POST /redeem", () => {
	it("rejects invalid JSON", async () => {
		const res = await mockApp.request("/redeem", {
			method: "POST",
			body: "not json",
		});
		expect(res.status).toBe(400);
	});

	it("rejects missing token and solutions", async () => {
		const res = await mockApp.request("/redeem", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ other: "field" }),
		});
		expect(res.status).toBe(400);
	});

	it("rejects invalid challenge token", async () => {
		const res = await mockApp.request("/redeem", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token: "fake-token", solutions: [1, 2, 3] }),
		});
		expect(res.status).toBe(400);
		const json = await res.json();
		expect(json.success).toBe(false);
	});

	it("returns success with token on valid solution", async () => {
		const res = await mockApp.request("/redeem", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token: "valid-token", solutions: [1, 2, 3] }),
		});
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.success).toBe(true);
		expect(json.token).toBe("redeemed-token");
		expect(json.expires).toBeDefined();
	});
});

describe("POST /verify", () => {
	it("rejects invalid JSON", async () => {
		const res = await mockApp.request("/verify", {
			method: "POST",
			body: "not json",
		});
		expect(res.status).toBe(400);
	});

	it("rejects invalid token", async () => {
		const res = await mockApp.request("/verify", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token: "invalid-token" }),
		});
		const json = await res.json();
		expect(json.success).toBe(false);
	});

	it("accepts valid token", async () => {
		const res = await mockApp.request("/verify", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token: "redeemed-token" }),
		});
		const json = await res.json();
		expect(json.success).toBe(true);
	});

	it("rejects missing token", async () => {
		const res = await mockApp.request("/verify", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		const json = await res.json();
		expect(json.success).toBe(false);
	});
});

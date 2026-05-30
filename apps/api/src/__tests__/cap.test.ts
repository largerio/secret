import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createRateLimit } from "../middleware/rateLimit.js";
import { type CapChallengeConfig, createCapRoutes, DEFAULT_CAP_CONFIG } from "../routes/cap.js";

function mockEnv(remoteAddress: string): { incoming: { socket: { remoteAddress: string } } } {
	return { incoming: { socket: { remoteAddress } } };
}

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

	it("defaults reproduce the historical challenge configuration", () => {
		expect(DEFAULT_CAP_CONFIG).toEqual({
			challengeCount: 50,
			challengeSize: 32,
			challengeDifficulty: 4,
			expiresMs: 600_000,
		});
	});

	it("forwards a custom challenge configuration to createChallenge", async () => {
		const config: CapChallengeConfig = {
			challengeCount: 12,
			challengeSize: 16,
			challengeDifficulty: 5,
			expiresMs: 120_000,
		};
		const createChallenge = vi.fn(async () => ({ challenge: {}, token: "t", expires: 0 }));
		// biome-ignore lint/suspicious/noExplicitAny: test mock
		const configuredApp = createCapRoutes({ createChallenge } as any, config);

		const res = await configuredApp.request("/challenge", { method: "POST" });
		expect(res.status).toBe(200);
		expect(createChallenge).toHaveBeenCalledWith(config);
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

describe("rate limiting", () => {
	it("returns 429 once the per-IP challenge limit is exceeded", async () => {
		const max = 3;
		const rl = createRateLimit({ windowMs: 60_000, max });
		const rateLimited = new Hono();
		rateLimited.use("/api/cap/*", rl.middleware);
		rateLimited.route("/api/cap", createCapRoutes());

		for (let i = 0; i < max; i++) {
			const ok = await rateLimited.request(
				"/api/cap/challenge",
				{ method: "POST" },
				mockEnv("9.9.9.9"),
			);
			expect(ok.status).toBe(200);
		}

		const blocked = await rateLimited.request(
			"/api/cap/challenge",
			{ method: "POST" },
			mockEnv("9.9.9.9"),
		);
		expect(blocked.status).toBe(429);
		expect(await blocked.json()).toEqual({ error: "Too many requests" });

		rl.cleanup();
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

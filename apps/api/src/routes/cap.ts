import Cap from "@cap.js/server";
import {
	CAP_CHALLENGE_EXPIRES_MS,
	CAP_CHALLENGE_SIZE,
	DEFAULT_CAP_CHALLENGE_COUNT,
	DEFAULT_CAP_DIFFICULTY,
} from "@secret/shared";
import { Hono } from "hono";

const cap = new Cap({ noFSState: true });

export interface CapChallengeConfig {
	challengeCount: number;
	challengeSize: number;
	challengeDifficulty: number;
	expiresMs: number;
}

export const DEFAULT_CAP_CONFIG: CapChallengeConfig = {
	challengeCount: DEFAULT_CAP_CHALLENGE_COUNT,
	challengeSize: CAP_CHALLENGE_SIZE,
	challengeDifficulty: DEFAULT_CAP_DIFFICULTY,
	expiresMs: CAP_CHALLENGE_EXPIRES_MS,
};

export function createCapRoutes(
	capInstance: InstanceType<typeof Cap> = cap,
	config: CapChallengeConfig = DEFAULT_CAP_CONFIG,
) {
	const app = new Hono();

	app.post("/challenge", async (c) => {
		const challenge = await capInstance.createChallenge({
			challengeCount: config.challengeCount,
			challengeSize: config.challengeSize,
			challengeDifficulty: config.challengeDifficulty,
			expiresMs: config.expiresMs,
		});

		return c.json(challenge);
	});

	app.post("/redeem", async (c) => {
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ success: false, message: "Invalid JSON" }, 400);
		}

		const { token, solutions } = body as { token?: string; solutions?: number[] };
		const result = await capInstance.redeemChallenge({
			token: token ?? "",
			solutions: solutions ?? [],
		});

		if (!result.success) {
			return c.json({ success: false, message: result.message }, 400);
		}

		return c.json({ success: true, token: result.token, expires: result.expires });
	});

	app.post("/verify", async (c) => {
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ success: false }, 400);
		}

		const { token } = body as { token?: string };
		const result = await capInstance.validateToken(token ?? "");

		return c.json({ success: result.success });
	});

	return app;
}

export { cap };

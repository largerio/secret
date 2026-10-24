import Cap from "@cap.js/server";
import {
	CAP_CHALLENGE_EXPIRES_MS,
	CAP_CHALLENGE_SIZE,
	DEFAULT_CAP_CHALLENGE_COUNT,
	DEFAULT_CAP_DIFFICULTY,
} from "@largerio/secret-shared";
import { Hono } from "hono";
import { z } from "zod";

const cap = new Cap({ noFSState: true });

// Cap's redeem payload is an internal (undocumented) contract, so the schema
// lives here rather than in @largerio/secret-shared.
const redeemSchema = z.object({
	token: z.string(),
	solutions: z.array(z.number()),
});

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

		const parsed = redeemSchema.safeParse(body);
		if (!parsed.success) {
			return c.json({ success: false, message: "Invalid request" }, 400);
		}

		const result = await capInstance.redeemChallenge(parsed.data);

		if (!result.success) {
			return c.json({ success: false, message: result.message }, 400);
		}

		return c.json({ success: true, token: result.token, expires: result.expires });
	});

	return app;
}

export { cap };

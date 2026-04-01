import Cap from "@cap.js/server";
import { Hono } from "hono";

const cap = new Cap({ noFSState: true });

export function createCapRoutes(capInstance: InstanceType<typeof Cap> = cap) {
	const app = new Hono();

	app.post("/challenge", async (c) => {
		const challenge = await capInstance.createChallenge({
			challengeCount: 50,
			challengeSize: 32,
			challengeDifficulty: 4,
			expiresMs: 600_000,
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

import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type AppMetrics, createMetricsHandler } from "../metrics.js";

/**
 * The scrapes in metrics.test.ts only see the verdict, which `candidate !==
 * token` gives too, in a time that tells how much of the token a guess got
 * right. These check that the handler leaves the comparison to
 * verifyApiKeyBuffers, the constant-time one the API keys go through. In their
 * own file because the mock is hoisted to module scope; it delegates to the
 * real function unless a test says otherwise.
 */
const { verify } = vi.hoisted(() => ({
	verify: vi.fn<(candidate: string, known: ReadonlyArray<Buffer>) => boolean>(),
}));

vi.mock("@largerio/secret-shared/auth", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@largerio/secret-shared/auth")>();
	verify.mockImplementation(actual.verifyApiKeyBuffers);
	return { ...actual, verifyApiKeyBuffers: verify };
});

const TOKEN = "m".repeat(32);

async function scrape(authorization: string): Promise<Response> {
	const metrics = { render: () => "secret_up 1\n" } as unknown as AppMetrics;
	const app = new Hono();
	app.get("/api/metrics", createMetricsHandler(metrics, TOKEN));
	return app.request("/api/metrics", { headers: { Authorization: authorization } });
}

beforeEach(() => {
	verify.mockClear();
});

describe("createMetricsHandler", () => {
	it("hands the bearer token and the configured one to verifyApiKeyBuffers", async () => {
		const res = await scrape(`Bearer ${TOKEN}`);

		expect(res.status).toBe(200);
		expect(verify).toHaveBeenCalledExactlyOnceWith(TOKEN, [Buffer.from(TOKEN)]);
	});

	it("follows its verdict, whatever the token", async () => {
		verify.mockReturnValueOnce(false);
		expect((await scrape(`Bearer ${TOKEN}`)).status).toBe(401);

		verify.mockReturnValueOnce(true);
		const res = await scrape("Bearer not-the-token");
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("secret_up 1\n");
		expect(verify).toHaveBeenLastCalledWith("not-the-token", [Buffer.from(TOKEN)]);
	});
});

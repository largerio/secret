import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CliError, EXIT } from "../errors.js";
import { findNonce, isWithinBounds, prng, solveProofOfWork } from "../pow.js";
import { cliErrorOf } from "./harness.js";

const BASE = "https://secret.example";
// The example of PROTOCOL.md, "Proof of work", computed with Cap's own code.
const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef01";
const SALT_1 = "2b5c4ca2fbc3e5066b0fb0573da6c475";
const SALT_2 = "a252484e802441830a9094a918b2adcb";
const REDEEMED = "a5fd561392de249f:7bc090f523cca7ae2b380e6ac8e113";

interface Call {
	readonly url: string;
	readonly init: RequestInit | undefined;
}

type Answer = Response | Error | ((init: RequestInit | undefined) => Promise<Response>);

/** A fetch giving these answers in turn, which records the requests it gets. */
function instance(...answers: Answer[]): { fetch: typeof fetch; calls: Call[] } {
	const calls: Call[] = [];
	const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		calls.push({ url: String(input), init });
		const answer = answers.shift();
		if (answer === undefined) throw new Error(`unexpected request to ${String(input)}`);
		if (answer instanceof Error) throw answer;
		if (typeof answer === "function") return answer(init);
		return answer;
	};
	return { fetch, calls };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...headers },
	});
}

function challenge(c: number, s: number, d: number, token: string = TOKEN): Response {
	return json({ challenge: { c, s, d }, token, expires: Date.now() + 600_000 });
}

const redeemed = () => json({ success: true, token: REDEEMED, expires: Date.now() + 1_200_000 });

/** The CliError the proof of work fails with, its message checked. */
async function failsWith(promise: Promise<unknown>, message: string): Promise<CliError> {
	const error = await cliErrorOf(() => promise);
	expect(error).toMatchObject({ message, exitCode: EXIT.failure });
	return error;
}

/** A fetch that answers only once its request is aborted, with the abort's reason. */
function hanging(init: RequestInit | undefined): Promise<Response> {
	return new Promise((_resolve, reject) => {
		const signal = init?.signal;
		signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
	});
}

afterEach(() => {
	vi.useRealTimers();
});

describe("prng", () => {
	it("derives Cap's salts and targets from the challenge's token", () => {
		expect(prng(`${TOKEN}1`, 32)).toBe(SALT_1);
		expect(prng(`${TOKEN}1d`, 4)).toBe("b948");
		expect(prng(`${TOKEN}2`, 32)).toBe(SALT_2);
		expect(prng(`${TOKEN}2d`, 4)).toBe("105e");
	});

	it("writes its words as 8 hex digits, then cuts to the length asked", () => {
		expect(prng(`${TOKEN}1`, 8)).toBe("2b5c4ca2");
		expect(prng(`${TOKEN}1`, 11)).toBe("2b5c4ca2fbc");
		expect(prng(`${TOKEN}1d`, 1)).toBe("b");
		expect(prng(TOKEN, 0)).toBe("");
	});
});

describe("findNonce", () => {
	it.each([
		[SALT_1, "b948", 20759, "b948954ef5a255fac7e357ec97ba8b9eca5ed9879b2e33d441fad0030dc00674"],
		[SALT_2, "105e", 12490, "105eadbd77d3dec19ca1ea80425e8fe2ef82e8e141e3847c309cd6d096060799"],
	])(
		"finds the first nonce whose hash starts with the target: %s",
		async (salt, target, first, digest) => {
			const nonce = await findNonce(salt, target);

			expect(nonce).toBe(first);
			expect(
				createHash("sha256")
					.update(`${salt}${String(nonce)}`)
					.digest("hex"),
			).toBe(digest);
		},
	);

	it("gives up after its attempts", async () => {
		await failsWith(
			findNonce(SALT_1, "b948", { attempts: 5000 }),
			"found no solution to the proof-of-work challenge",
		);
	});

	it("stops between two batches once its signal is aborted", async () => {
		const reason = new Error("interrupted");

		await expect(findNonce(SALT_1, "b948", { signal: AbortSignal.abort(reason) })).rejects.toBe(
			reason,
		);
	});
});

describe("isWithinBounds", () => {
	it.each([
		["the default", 50, 32, 4],
		["the most challenges", 1024, 64, 1],
		["the longest salt", 1, 64, 1],
		["the highest difficulty, at the most work", 8, 64, 6],
		["the most work at difficulty 5", 128, 32, 5],
	])("takes %s: c=%d, s=%d, d=%d", (_name, count, saltLength, difficulty) => {
		expect(isWithinBounds({ count, saltLength, difficulty })).toBe(true);
	});

	it.each([
		["too many challenges", 1025, 32, 1],
		["a salt too long", 1, 65, 1],
		["a difficulty too high", 1, 32, 7],
		["too much work at difficulty 6", 9, 64, 6],
		["the default count at difficulty 6", 50, 32, 6],
		["too much work at difficulty 5", 129, 32, 5],
	])("refuses %s: c=%d, s=%d, d=%d", (_name, count, saltLength, difficulty) => {
		expect(isWithinBounds({ count, saltLength, difficulty })).toBe(false);
	});
});

describe("solveProofOfWork", () => {
	it("solves each challenge and returns the token they redeem for", async () => {
		const { fetch, calls } = instance(challenge(2, 32, 1), redeemed());
		const progress: Array<[number, number]> = [];

		const token = await solveProofOfWork(BASE, {
			fetch,
			onProgress: (solved, total) => progress.push([solved, total]),
		});

		expect(token).toBe(REDEEMED);
		expect(progress).toEqual([
			[1, 2],
			[2, 2],
		]);
		expect(calls.map((call) => [call.url, call.init?.method])).toEqual([
			[`${BASE}/api/cap/challenge`, "POST"],
			[`${BASE}/api/cap/redeem`, "POST"],
		]);
		expect(calls[0]?.init?.body).toBeUndefined();
		expect(calls[1]?.init?.headers).toEqual({ "Content-Type": "application/json" });
		// The first nonces whose hashes start with "b" and "1".
		expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ token: TOKEN, solutions: [13, 4] });
	});

	it("asks the instance under its path, whatever its trailing slashes", async () => {
		const { fetch, calls } = instance(challenge(1, 32, 1), redeemed());

		await solveProofOfWork("https://example.org/secret//", { fetch });

		expect(calls.map((call) => call.url)).toEqual([
			"https://example.org/secret/api/cap/challenge",
			"https://example.org/secret/api/cap/redeem",
		]);
	});

	it("solves as many challenges and as long salts as its bounds allow", async () => {
		const { fetch, calls } = instance(challenge(1024, 64, 1), redeemed());

		await solveProofOfWork(BASE, { fetch });

		const { solutions } = JSON.parse(String(calls[1]?.init?.body)) as { solutions: number[] };
		expect(solutions).toHaveLength(1024);
		const salt = prng(`${TOKEN}1024`, 64);
		const target = prng(`${TOKEN}1024d`, 1);
		const digest = createHash("sha256")
			.update(`${salt}${String(solutions[1023])}`)
			.digest("hex");
		expect(digest.startsWith(target)).toBe(true);
	});

	describe("refuses a challenge it cannot trust", () => {
		const cannotSolve = `${BASE} sent a proof-of-work challenge this version of secret cannot solve`;

		it.each([
			["a body that is not JSON", new Response("<html>")],
			["no body", new Response(null)],
			["an array", json([])],
			["no challenge", json({ token: TOKEN })],
			["no token", json({ challenge: { c: 1, s: 32, d: 1 } })],
			["a token that is not a string", challenge(1, 32, 1, 42 as unknown as string)],
			["an empty token", challenge(1, 32, 1, "")],
			["a token with a space", challenge(1, 32, 1, "01 23")],
			["a token too long", challenge(1, 32, 1, "a".repeat(257))],
			["no challenges", challenge(0, 32, 1)],
			["a count that is not an integer", challenge(1.5, 32, 1)],
			["a salt length of 0", challenge(1, 0, 1)],
			["a difficulty of 0", challenge(1, 32, 0)],
			["a negative difficulty", challenge(1, 32, -4)],
			["a difficulty that is not a number", challenge(1, 32, "4" as unknown as number)],
			["a format of another version", json({ format: 2, challenges: [], token: TOKEN })],
		])("%s", async (_case, answer) => {
			const { fetch, calls } = instance(answer);

			await failsWith(solveProofOfWork(BASE, { fetch }), cannotSolve);
			expect(calls).toHaveLength(1);
		});

		it.each([
			["too many challenges", 1025, 32, 1],
			["a salt too long", 1, 65, 1],
			["a difficulty too high", 1, 32, 7],
			["too much work in all", 9, 32, 6],
		])("%s", async (_case, c, s, d) => {
			const { fetch, calls } = instance(challenge(c, s, d));

			await failsWith(
				solveProofOfWork(BASE, { fetch }),
				`${BASE} asks for more proof of work than secret solves (c=${String(c)}, s=${String(s)}, d=${String(d)}): such an instance is written to with an API key, set in SECRET_API_KEY`,
			);
			expect(calls).toHaveLength(1);
		});

		it("an answer longer than any of Cap's", async () => {
			const { fetch } = instance(new Response("x".repeat(64 * 1024 + 1)));

			await failsWith(
				solveProofOfWork(BASE, { fetch }),
				`${BASE} answered more than 64 KiB to a proof-of-work request`,
			);
		});
	});

	describe("reports the instance's refusals", () => {
		it("a rate limit, with the wait it asks for", async () => {
			const limited = json({ code: "rate_limited" }, 429, { "Retry-After": "17" });
			const { fetch } = instance(limited);

			await failsWith(
				solveProofOfWork(BASE, { fetch }),
				`${BASE} takes no more requests from this address for now: try again in 17s`,
			);
		});

		it.each([
			["no Retry-After", new Response(null, { status: 429 })],
			[
				"a Retry-After as a date",
				new Response(null, {
					status: 429,
					headers: { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" },
				}),
			],
		])("a rate limit with %s", async (_case, answer) => {
			const { fetch } = instance(answer);

			await failsWith(
				solveProofOfWork(BASE, { fetch }),
				`${BASE} takes no more requests from this address for now: try again later`,
			);
		});

		it("a rate limit on the solution", async () => {
			const { fetch } = instance(challenge(1, 32, 1), json({}, 429, { "Retry-After": "3" }));

			await failsWith(
				solveProofOfWork(BASE, { fetch }),
				`${BASE} takes no more requests from this address for now: try again in 3s`,
			);
		});

		it("an error, by the code of its problem details", async () => {
			const { fetch } = instance(json({ code: "internal_error", detail: "boom" }, 500));

			await failsWith(
				solveProofOfWork(BASE, { fetch }),
				`${BASE} answered HTTP 500 (internal_error) to the proof-of-work challenge request`,
			);
		});

		it.each([
			["no body", new Response(null, { status: 502 })],
			["a code it does not repeat", json({ code: "\u001b[2Jcleared" }, 502)],
		])("an error with %s, by its status", async (_case, answer) => {
			const { fetch } = instance(answer);

			await failsWith(
				solveProofOfWork(BASE, { fetch }),
				`${BASE} answered HTTP 502 to the proof-of-work challenge request`,
			);
		});

		it("a solution refused, in Cap's words", async () => {
			const refused = json({ success: false, message: "Challenge invalid or expired" }, 400);
			const { fetch } = instance(challenge(1, 32, 1), refused);

			await failsWith(
				solveProofOfWork(BASE, { fetch }),
				`${BASE} refused the proof of work: Challenge invalid or expired`,
			);
		});

		it.each([
			["words it does not repeat", { success: false, message: "\u001b]0;owned\u0007" }],
			["no words", { success: false }],
		])("a solution refused with %s", async (_case, body) => {
			const { fetch } = instance(challenge(1, 32, 1), json(body, 400));

			await failsWith(solveProofOfWork(BASE, { fetch }), `${BASE} refused the proof of work`);
		});

		it("a solution refused by something else than Cap", async () => {
			const invalid = json({ code: "invalid_request", detail: "Invalid request" }, 400);
			const { fetch } = instance(challenge(1, 32, 1), invalid);

			await failsWith(
				solveProofOfWork(BASE, { fetch }),
				`${BASE} answered HTTP 400 (invalid_request) to the proof-of-work solution`,
			);
		});

		it.each([
			["no token", { success: true }],
			["a token that is not a string", { success: true, token: 7 }],
			["a token that is no header value", { success: true, token: "id:token\r\nX-Other: 1" }],
			["no success", { token: REDEEMED }],
			["no JSON object", "token"],
		])("a solution accepted with %s", async (_case, body) => {
			const { fetch } = instance(challenge(1, 32, 1), json(body));

			await failsWith(
				solveProofOfWork(BASE, { fetch }),
				`${BASE} accepted the proof of work but sent no token`,
			);
		});
	});

	describe("fails on the way", () => {
		it("an instance it cannot reach", async () => {
			const cause = new TypeError("fetch failed");
			const { fetch } = instance(cause);

			const error = await failsWith(solveProofOfWork(BASE, { fetch }), `could not reach ${BASE}`);
			expect(error.cause).toBe(cause);
		});

		it("an instance that does not answer", async () => {
			vi.useFakeTimers();
			const { fetch } = instance(hanging);

			const solving = solveProofOfWork(BASE, { fetch });
			const failed = failsWith(
				solving,
				`${BASE} did not answer the proof-of-work request within 30 seconds`,
			);
			await vi.advanceTimersByTimeAsync(30_000);

			await failed;
		});
	});

	describe("stops once its signal is aborted", () => {
		it("before asking for anything", async () => {
			const reason = new Error("interrupted");
			const { fetch, calls } = instance();

			await expect(
				solveProofOfWork(BASE, { fetch, signal: AbortSignal.abort(reason) }),
			).rejects.toBe(reason);
			expect(calls).toEqual([]);
		});

		it("while waiting for the instance", async () => {
			const controller = new AbortController();
			const reason = new Error("interrupted");
			const { fetch } = instance((init) => {
				queueMicrotask(() => controller.abort(reason));
				return hanging(init);
			});

			await expect(solveProofOfWork(BASE, { fetch, signal: controller.signal })).rejects.toBe(
				reason,
			);
		});

		it("while solving", async () => {
			const controller = new AbortController();
			const reason = new Error("interrupted");
			const progress = vi.fn();
			// Challenge 1 is the one of the example, 20,760 hashes: several batches.
			const { fetch, calls } = instance(async () => {
				setImmediate(() => controller.abort(reason));
				return challenge(1, 32, 4);
			});

			await expect(
				solveProofOfWork(BASE, { fetch, signal: controller.signal, onProgress: progress }),
			).rejects.toBe(reason);
			expect(progress).not.toHaveBeenCalled();
			expect(calls).toHaveLength(1);
		});

		it("between the last challenge and the solution", async () => {
			const controller = new AbortController();
			const reason = new Error("interrupted");
			const { fetch, calls } = instance(challenge(1, 32, 1), redeemed());

			await expect(
				solveProofOfWork(BASE, {
					fetch,
					signal: controller.signal,
					onProgress: () => controller.abort(reason),
				}),
			).rejects.toBe(reason);
			expect(calls).toHaveLength(1);
		});
	});
});

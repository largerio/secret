import { hash } from "node:crypto";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseJson, problemCodeOf, rateLimited, readBodyAtMost, recordOf } from "./answers.js";
import { CliError, EXIT } from "./errors.js";

/*
 * The proof of work is Cap's (PROTOCOL.md, "Proof of work"), as the instance
 * serves it under /api/cap/. Cap is free to change it in any release: a
 * contract test runs this file against the real application
 * (apps/api/src/__tests__/proofOfWork.test.ts).
 *
 * The instance is not trusted to ask for a sane amount of work. Its challenge
 * is refused beyond these bounds, which leave room around what an instance
 * can be configured to serve (50 challenges of difficulty 4 by default,
 * CAP_DIFFICULTY up to 6, salts of 32 hex characters).
 */

/** The most challenges, `c`. */
const MAX_CHALLENGES = 1024;
/** The longest salt, `s`, in hex characters. */
const MAX_SALT_LENGTH = 64;
/** The longest target, `d`, in hex characters. */
const MAX_DIFFICULTY = 6;
/**
 * The most hashes the challenges may take on average, `c × 16^d`: 40 times
 * the default's 3.3 million, under a minute on one core.
 */
const MAX_EXPECTED_HASHES = 2 ** 27;
/**
 * A challenge is given up after this many times the hashes it takes on
 * average, which an honest one exceeds with probability e^-64: the search
 * always ends, and its nonces stay plain decimal integers.
 */
const ATTEMPTS_PER_EXPECTED = 64;
/** Hashes between two turns of the event loop: a millisecond or two. */
const BATCH = 4096;
const REQUEST_TIMEOUT_MS = 30_000;
/** The answers are a few hundred bytes: anything longer is not Cap's. */
const MAX_RESPONSE_BYTES = 64 * 1024;

/** Visible ASCII: the challenge's id and the token, sent back as they came. */
const VISIBLE = /^[!-~]{1,256}$/;
/** What of the instance's own words a message may repeat to the terminal. */
const PRINTABLE = /^[ -~]{1,200}$/;

export interface ProofOfWorkOptions {
	readonly fetch: typeof fetch;
	readonly signal?: AbortSignal;
	/** Called each time one of the instance's challenges is solved. */
	readonly onProgress?: (solved: number, total: number) => void;
}

/**
 * Solves the instance's proof-of-work challenge and returns the single-use
 * write token it redeems for (`X-Cap-Token`).
 *
 * Rejects with a {@link CliError} when the instance cannot be reached, refuses
 * or asks for more work than the bounds above, and with the signal's reason
 * once it is aborted.
 */
export async function solveProofOfWork(
	baseUrl: string,
	options: ProofOfWorkOptions,
): Promise<string> {
	const base = baseUrl.replace(/\/+$/, "");
	const instance: CapInstance = {
		base,
		origin: new URL(base).origin,
		fetch: options.fetch,
		signal: options.signal,
	};

	const challenge = challengeOf(
		await post(instance, "/api/cap/challenge", { method: "POST" }),
		instance.origin,
	);

	const solutions: number[] = [];
	for (let i = 1; i <= challenge.count; i++) {
		const salt = prng(`${challenge.token}${String(i)}`, challenge.saltLength);
		const target = prng(`${challenge.token}${String(i)}d`, challenge.difficulty);
		solutions.push(await findNonce(salt, target, { signal: options.signal }));
		options.onProgress?.(i, challenge.count);
	}

	const redeemed = await post(instance, "/api/cap/redeem", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ token: challenge.token, solutions }),
	});

	return tokenOf(redeemed, instance.origin);
}

/**
 * Cap's generator: the FNV-1a hash (32 bits) of the seed's characters seeds
 * a xorshift32 (13, 17, 5), whose words are written as 8 hex digits each,
 * then cut to `length` characters.
 */
export function prng(seed: string, length: number): string {
	let state = 0x811c9dc5;
	for (let i = 0; i < seed.length; i++) {
		state = Math.imul(state ^ seed.charCodeAt(i), 0x01000193);
	}

	let out = "";
	while (out.length < length) {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		out += (state >>> 0).toString(16).padStart(8, "0");
	}

	return out.slice(0, length);
}

/**
 * The first nonce, counting from 0, whose SHA-256 of `<salt><nonce>` starts
 * with `target` in hex. It hashes in batches and lets the event loop run
 * between them, so a Ctrl-C is heard within a batch.
 */
export async function findNonce(
	salt: string,
	target: string,
	options: { readonly signal?: AbortSignal | undefined; readonly attempts?: number } = {},
): Promise<number> {
	const attempts = options.attempts ?? ATTEMPTS_PER_EXPECTED * 16 ** target.length;

	for (let nonce = 0; nonce < attempts; ) {
		const end = Math.min(nonce + BATCH, attempts);
		for (; nonce < end; nonce++) {
			if (hash("sha256", `${salt}${String(nonce)}`).startsWith(target)) {
				return nonce;
			}
		}

		await nextTurn();
		options.signal?.throwIfAborted();
	}

	throw new CliError("found no solution to the proof-of-work challenge");
}

/** The instance whose proof of work is solved, as its requests go to it. */
interface CapInstance {
	/** The instance's URL, without a trailing slash. */
	readonly base: string;
	/** What the messages name the instance by. */
	readonly origin: string;
	readonly fetch: typeof fetch;
	readonly signal: AbortSignal | undefined;
}

/** An answer of the instance, its body read whole. */
interface CapResponse {
	readonly status: number;
	readonly ok: boolean;
	readonly retryAfter: string | null;
	/** The body parsed as JSON, or undefined when it is not JSON. */
	readonly body: unknown;
}

interface Challenge {
	readonly token: string;
	readonly count: number;
	readonly saltLength: number;
	readonly difficulty: number;
}

/**
 * One request, its whole answer read, within a timeout. The caller's signal
 * cancels it, and its abort is what the request then rejects with.
 */
async function post(instance: CapInstance, path: string, init: RequestInit): Promise<CapResponse> {
	const { fetch: request, signal } = instance;
	signal?.throwIfAborted();

	const controller = new AbortController();
	const cancel = () => controller.abort(signal?.reason);
	signal?.addEventListener("abort", cancel, { once: true });
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

	try {
		const response = await request(`${instance.base}${path}`, {
			...init,
			signal: controller.signal,
		});
		const text = await readBodyAtMost(response, MAX_RESPONSE_BYTES);
		if (text === undefined) {
			throw new CliError(
				`${instance.origin} answered more than ${String(MAX_RESPONSE_BYTES / 1024)} KiB to a proof-of-work request`,
			);
		}

		return {
			status: response.status,
			ok: response.ok,
			retryAfter: response.headers.get("Retry-After"),
			body: parseJson(text),
		};
	} catch (error) {
		signal?.throwIfAborted();

		if (error instanceof CliError) {
			throw error;
		}

		if (controller.signal.aborted) {
			throw new CliError(
				`${instance.origin} did not answer the proof-of-work request within ${String(REQUEST_TIMEOUT_MS / 1000)} seconds`,
			);
		}

		throw new CliError(`could not reach ${instance.origin}`, EXIT.failure, { cause: error });
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", cancel);
	}
}

function challengeOf(response: CapResponse, origin: string): Challenge {
	if (!response.ok) {
		throw refusalOf(response, origin, "challenge request");
	}

	const body = recordOf(response.body);
	const challenge = recordOf(body?.["challenge"]);
	const token = body?.["token"];
	const count = challenge?.["c"];
	const saltLength = challenge?.["s"];
	const difficulty = challenge?.["d"];

	if (
		typeof token !== "string" ||
		!VISIBLE.test(token) ||
		!isPositiveInteger(count) ||
		!isPositiveInteger(saltLength) ||
		!isPositiveInteger(difficulty)
	) {
		throw new CliError(
			`${origin} sent a proof-of-work challenge this version of secret cannot solve`,
		);
	}

	if (
		count > MAX_CHALLENGES ||
		saltLength > MAX_SALT_LENGTH ||
		difficulty > MAX_DIFFICULTY ||
		count * 16 ** difficulty > MAX_EXPECTED_HASHES
	) {
		throw new CliError(
			`${origin} asks for more proof of work than secret does (c=${String(count)}, s=${String(saltLength)}, d=${String(difficulty)}): write with an API key, in SECRET_API_KEY`,
		);
	}

	return { token, count, saltLength, difficulty };
}

function tokenOf(response: CapResponse, origin: string): string {
	const body = recordOf(response.body);

	// Cap refuses a wrong, unknown or expired solution with a 400 of its own,
	// not a problem details object.
	if (response.status === 400 && body?.["success"] === false) {
		const message = body["message"];
		const reason = typeof message === "string" && PRINTABLE.test(message) ? `: ${message}` : "";
		throw new CliError(`${origin} refused the proof of work${reason}`);
	}

	if (!response.ok) {
		throw refusalOf(response, origin, "solution");
	}

	const token = body?.["token"];
	if (body?.["success"] !== true || typeof token !== "string" || !VISIBLE.test(token)) {
		throw new CliError(`${origin} accepted the proof of work but sent no token`);
	}

	return token;
}

/** The refusal of a request, in the instance's words where they can be trusted. */
function refusalOf(response: CapResponse, origin: string, step: string): CliError {
	if (response.status === 429) {
		const seconds = response.retryAfter?.trim() ?? "";
		return rateLimited(origin, /^\d{1,9}$/.test(seconds) ? Number(seconds) : undefined);
	}

	const code = problemCodeOf(recordOf(response.body)?.["code"]);
	const named = code === undefined ? "" : ` (${code})`;
	return new CliError(
		`${origin} answered HTTP ${String(response.status)}${named} to the proof-of-work ${step}`,
	);
}

function isPositiveInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 1;
}

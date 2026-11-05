import { describe, expect, it, vi } from "vitest";
import { CliError, EXIT } from "../errors.js";
import { connect, fetchLimits, instanceOf, linkOf, proofOfWork } from "../instance.js";
import { createScreen } from "../terminal.js";
import { harness, instanceFetch, KEY, LIMITS, LINK, NOTE_ID, ORIGIN, Output } from "./harness.js";

// The real proof of work, replaced: the default must be the one `pow.ts` exports.
const pow = vi.hoisted(() => ({ solveProofOfWork: vi.fn(async () => "default-token") }));
vi.mock("../pow.js", () => pow);

const instance = { baseUrl: `${ORIGIN}/secret`, origin: ORIGIN };

function failure(promise: Promise<unknown>): Promise<CliError> {
	return promise.then(
		() => {
			throw new Error("no failure");
		},
		(err: unknown) => {
			expect(err).toBeInstanceOf(CliError);
			return err as CliError;
		},
	);
}

describe("instanceOf", () => {
	it("keeps the origin and the path, without its trailing slashes", () => {
		expect(instanceOf("https://secret.example/")).toEqual({
			baseUrl: ORIGIN,
			origin: ORIGIN,
		});
		expect(instanceOf("http://localhost:3000/secret//?x=1#y")).toEqual({
			baseUrl: "http://localhost:3000/secret",
			origin: "http://localhost:3000",
		});
	});

	it.each(["secret.example", "ftp://secret.example", "file:///etc/passwd"])(
		"refuses %s",
		(value) => {
			expect(() => instanceOf(value)).toThrow(
				expect.objectContaining({
					message: "the instance must be an http or https URL",
					exitCode: EXIT.usage,
				}),
			);
		},
	);
});

describe("linkOf", () => {
	it("splits a link into its instance, its note and its key", () => {
		expect(linkOf(LINK)).toEqual({
			baseUrl: ORIGIN,
			origin: ORIGIN,
			id: NOTE_ID,
			keyFragment: KEY,
		});
	});

	it("keeps the path an instance is served under", () => {
		expect(linkOf(`${ORIGIN}/apps/secret/note/${NOTE_ID}#${KEY}`)).toMatchObject({
			baseUrl: `${ORIGIN}/apps/secret`,
			origin: ORIGIN,
			id: NOTE_ID,
		});
	});

	it.each([
		[`/note/${NOTE_ID}#${KEY}`, "this is not a link: give the whole of it, https:// included"],
		[`javascript:alert(1)//note/${NOTE_ID}#${KEY}`, "the link must be an http or https URL"],
		[
			`${ORIGIN}/note/${NOTE_ID}`,
			"this is not the link of a note: invalid share URL: missing key fragment",
		],
		[
			`${ORIGIN}/notes/${NOTE_ID}#${KEY}`,
			"this is not the link of a note: invalid share URL: missing note ID",
		],
		[`${ORIGIN}/note/${NOTE_ID}#%E0%A4%A`, "this is not the link of a note: invalid share URL"],
	])("refuses %s without repeating it", (link, message) => {
		expect(() => linkOf(link)).toThrow(expect.objectContaining({ message, exitCode: EXIT.usage }));
	});
});

describe("fetchLimits", () => {
	it("reads the instance's configuration", async () => {
		const fetch = instanceFetch();
		const { io } = harness({ fetch });
		expect(await fetchLimits(io, instance)).toEqual(LIMITS);
		expect(fetch).toHaveBeenCalledWith(`${ORIGIN}/secret/api/v1/config`, {
			headers: { accept: "application/json" },
			signal: io.signal,
		});
	});

	it("names the instance it cannot reach", async () => {
		const { io } = harness({ fetch: vi.fn(() => Promise.reject(new TypeError("fetch failed"))) });
		const error = await failure(fetchLimits(io, instance));
		expect(error).toMatchObject({ message: `could not reach ${ORIGIN}`, exitCode: EXIT.failure });
	});

	it.each([
		[new Response("no", { status: 404 }), "HTTP 404"],
		[new Response("<html>", { status: 200 }), "not the answer of one"],
		[Response.json(null), "not the answer of one"],
		[Response.json({ ...LIMITS, chunkSize: "4MB" }), "not the answer of one"],
		[Response.json({ ...LIMITS, maxExpiry: 0 }), "not the answer of one"],
	])("refuses what is no instance's configuration (%#)", async (response, detail) => {
		const { io } = harness({ fetch: vi.fn(async () => response) });
		const error = await failure(fetchLimits(io, instance));
		expect(error.message).toBe(`${ORIGIN} gave no limits (${detail}): is it a Secret instance?`);
	});
});

describe("connect", () => {
	it("builds the client through the io, with the key of a write", async () => {
		const { io, configs, client } = harness();
		expect(await connect(io, instance, "key")).toBe(client);
		expect(await connect(io, instance)).toBe(client);
		expect(configs).toEqual([
			{ baseUrl: `${ORIGIN}/secret`, fetch: io.fetch, apiKey: "key" },
			{ baseUrl: `${ORIGIN}/secret`, fetch: io.fetch },
		]);
	});

	it("builds the SDK's own client by default", async () => {
		const { io } = harness();
		const { createClient: _, ...withoutFactory } = io;
		const client = await connect(withoutFactory, instance);
		expect(client.buildShareUrl(NOTE_ID, KEY)).toBe(
			`${ORIGIN}/secret/note/${NOTE_ID}#${encodeURIComponent(KEY)}`,
		);
	});
});

describe("proofOfWork", () => {
	it("solves the instance's proof of work, showing its progress", async () => {
		const stderr = new Output(true);
		const { io, pow: solve } = harness();
		const token = await proofOfWork(io, instance, createScreen(stderr, false));
		expect(token).toBe("cap-token");
		expect(solve).toHaveBeenCalledWith(`${ORIGIN}/secret`, {
			fetch: io.fetch,
			signal: io.signal,
			onProgress: expect.any(Function),
		});
		expect(stderr.text).toBe("\r\u001b[KProof of work 1/2\r\u001b[KProof of work 2/2\r\u001b[K");
	});

	it("uses the one of pow.ts by default", async () => {
		const { io } = harness();
		const { solveProofOfWork: _, ...withoutSolver } = io;
		expect(await proofOfWork(withoutSolver, instance, createScreen(new Output(), true))).toBe(
			"default-token",
		);
		expect(pow.solveProofOfWork).toHaveBeenCalledOnce();
	});

	it("lets its own failures through", async () => {
		const refused = new CliError("the instance refused the challenge");
		const { io, pow: solve } = harness();
		solve.mockRejectedValueOnce(refused);
		await expect(proofOfWork(io, instance, createScreen(new Output(), true))).rejects.toBe(refused);
	});

	it("tells an unexpected failure apart, with a way out", async () => {
		const { io, pow: solve } = harness();
		solve.mockRejectedValueOnce(new TypeError("fetch failed"));
		const error = await failure(proofOfWork(io, instance, createScreen(new Output(), true)));
		expect(error).toMatchObject({
			message: `could not solve the proof of work of ${ORIGIN}: set SECRET_API_KEY to write with a key`,
			exitCode: EXIT.failure,
		});
		expect(error.cause).toBeInstanceOf(TypeError);
	});
});

import { describe, expect, it, vi } from "vitest";
import { CliError, EXIT } from "../errors.js";
import {
	assertKeyStaysPrivate,
	connect,
	fetchLimits,
	formatOfLink,
	instanceOf,
	linkOf,
	noteOf,
	proofOfWork,
} from "../instance.js";
import { createScreen } from "../terminal.js";
import {
	cliErrorOf,
	harness,
	instanceFetch,
	KEY,
	LIMITS,
	LINK,
	NOTE_ID,
	ORIGIN,
	Output,
	without,
} from "./harness.js";

// The real proof of work, replaced: the default must be the one `pow.ts` exports.
const pow = vi.hoisted(() => ({ solveProofOfWork: vi.fn(async () => "default-token") }));
vi.mock("../pow.js", () => pow);

const instance = { baseUrl: `${ORIGIN}/secret`, origin: ORIGIN };

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

/** A format 0 key: 43 base64url characters, the last one's two spare bits zero. */
const FORMAT_0_KEY = KEY.slice(2);

describe("noteOf", () => {
	it("splits a link into its instance and its note, without its key", () => {
		expect(noteOf(`${ORIGIN}/note/${NOTE_ID}`)).toEqual({
			baseUrl: ORIGIN,
			origin: ORIGIN,
			id: NOTE_ID,
		});
	});

	it("keeps the path an instance is served under", () => {
		expect(noteOf(`${ORIGIN}/apps/secret/note/${NOTE_ID}`)).toEqual({
			baseUrl: `${ORIGIN}/apps/secret`,
			origin: ORIGIN,
			id: NOTE_ID,
		});
	});

	it("leaves the key alone, whatever it is", () => {
		for (const fragment of ["", "#", `#${KEY}`, "#2.cut", "#%E0%A4%A"]) {
			expect(noteOf(`${LINK.split("#")[0]}${fragment}`)).toMatchObject({ id: NOTE_ID });
		}
	});

	it.each([
		[`/note/${NOTE_ID}`, "this is not a link: give the whole of it, https:// included"],
		[`javascript:alert(1)//note/${NOTE_ID}`, "the link must be an http or https URL"],
		[`${ORIGIN}/notes/${NOTE_ID}`, "this is not the link of a note"],
		[`${ORIGIN}/note`, "this is not the link of a note"],
		[`${ORIGIN}/note/`, "this is not the link of a note"],
		// Decoded, the id would end the path there, and the request would be another's.
		[`${ORIGIN}/note/${NOTE_ID}%3F`, "this is not the link of a note"],
		[`${ORIGIN}/note/${NOTE_ID.slice(1)}`, "this is not the link of a note"],
		[`${ORIGIN}/note/${NOTE_ID}x`, "this is not the link of a note"],
		[`${ORIGIN}/note/${NOTE_ID.slice(1)}.`, "this is not the link of a note"],
		[`${ORIGIN}/note/%41${NOTE_ID.slice(1)}`, "this is not the link of a note"],
	])("refuses %s without repeating it", (link, message) => {
		expect(() => noteOf(link)).toThrow(expect.objectContaining({ message, exitCode: EXIT.usage }));
	});
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

	it("takes the key of either format, decoded", () => {
		expect(linkOf(`${ORIGIN}/note/${NOTE_ID}#${FORMAT_0_KEY}`)).toMatchObject({
			keyFragment: FORMAT_0_KEY,
		});
		expect(linkOf(`${ORIGIN}/note/${NOTE_ID}#1%2E${FORMAT_0_KEY}`)).toMatchObject({
			keyFragment: KEY,
		});
	});

	it("refuses a link without a key", () => {
		expect(() => linkOf(`${ORIGIN}/note/${NOTE_ID}#`)).toThrow(
			expect.objectContaining({
				message: "the link has no key: give the whole of it, quoted, the part after # included",
				exitCode: EXIT.usage,
			}),
		);
	});

	it("refuses an id before its key", () => {
		expect(() => linkOf(`${ORIGIN}/note/${NOTE_ID}%3F#${KEY}`)).toThrow(
			expect.objectContaining({ message: "this is not the link of a note" }),
		);
	});

	it.each([
		["a format 1 key cut short", `1.${FORMAT_0_KEY.slice(1)}`],
		["a format 0 key cut short", FORMAT_0_KEY.slice(1)],
		["a key too long", `${FORMAT_0_KEY}A`],
		["a key whose last character carries stray bits", `${FORMAT_0_KEY.slice(0, -1)}B`],
		["a key out of the alphabet", `${FORMAT_0_KEY.slice(0, -1)}=`],
		["a format this version does not know", `2.${FORMAT_0_KEY}`],
		["a format written with a leading zero", `01.${FORMAT_0_KEY}`],
		["an encoding that does not decode", "%E0%A4%A"],
	])("refuses %s as a link wrong or damaged, without repeating it", (_name, fragment) => {
		expect(() => linkOf(`${ORIGIN}/note/${NOTE_ID}#${fragment}`)).toThrow(
			expect.objectContaining({ message: "the link is wrong or damaged", exitCode: EXIT.refused }),
		);
	});
});

describe("formatOfLink", () => {
	it("tells the format by the key's prefix", () => {
		expect(formatOfLink(linkOf(LINK))).toBe(1);
		expect(formatOfLink(linkOf(`${ORIGIN}/note/${NOTE_ID}#${FORMAT_0_KEY}`))).toBe(0);
	});
});

describe("fetchLimits", () => {
	it("reads the instance's configuration", async () => {
		const fetch = instanceFetch();
		const { io } = harness({ fetch });
		expect(await fetchLimits(io, instance)).toEqual(without(LIMITS, "maxFileSize"));
		expect(fetch).toHaveBeenCalledWith(`${ORIGIN}/secret/api/v1/config`, {
			headers: { accept: "application/json" },
			signal: io.signal,
		});
	});

	it("names the instance it cannot reach", async () => {
		const { io } = harness({ fetch: vi.fn(() => Promise.reject(new TypeError("fetch failed"))) });
		const error = await cliErrorOf(() => fetchLimits(io, instance));
		expect(error).toMatchObject({ message: `could not reach ${ORIGIN}`, exitCode: EXIT.failure });
	});

	it.each([
		[new Response("no", { status: 404 }), "HTTP 404"],
		[new Response("<html>", { status: 200 }), "not the answer of one"],
		[Response.json(null), "not the answer of one"],
		[Response.json([]), "not the answer of one"],
		[Response.json({ ...LIMITS, chunkSize: "4MB" }), "not the answer of one"],
		[Response.json({ ...LIMITS, chunkSize: 65_536.5 }), "not the answer of one"],
		[Response.json({ ...LIMITS, chunkSize: 65_535 }), "not the answer of one"],
		[Response.json({ ...LIMITS, chunkSize: 1 }), "not the answer of one"],
		[Response.json({ ...LIMITS, maxExpiry: 0 }), "not the answer of one"],
		[Response.json({ ...LIMITS, maxFilesPerNote: -1 }), "not the answer of one"],
		[Response.json({ ...LIMITS, maxChunkedFileSize: 2 ** 53 }), "not the answer of one"],
		[
			new Response(JSON.stringify({ ...LIMITS, padding: "x".repeat(64 * 1024) })),
			"not the answer of one",
		],
	])("refuses what is no instance's configuration (%#)", async (response, detail) => {
		const { io } = harness({ fetch: vi.fn(async () => response) });
		const error = await cliErrorOf(() => fetchLimits(io, instance));
		expect(error.message).toBe(`${ORIGIN} gave no limits (${detail}): is it a Secret instance?`);
	});
});

describe("assertKeyStaysPrivate", () => {
	it.each([
		"https://secret.example",
		"http://localhost:3000",
		"http://app.localhost",
		"http://127.0.0.1:8080",
		"http://127.1",
		"http://127.255.0.9",
		"http://[::1]:3000",
	])("lets a key go to %s", (url) => {
		expect(() => assertKeyStaysPrivate(instanceOf(url), false)).not.toThrow();
	});

	it.each([
		"http://secret.example",
		"http://10.0.0.1",
		"http://localhost.evil.example",
		"http://127.0.0.1.evil.example",
		"http://[::ffff:127.0.0.1]",
		"http://[::2]",
	])("keeps a key from going to %s in the clear", (url) => {
		const instance = instanceOf(url);
		expect(() => assertKeyStaysPrivate(instance, false)).toThrow(
			expect.objectContaining({
				message: `the API key would go to ${instance.origin} in the clear: use https, or pass --allow-http`,
				exitCode: EXIT.usage,
			}),
		);
		expect(() => assertKeyStaysPrivate(instance, true)).not.toThrow();
	});
});

describe("the chunk size of fetchLimits", () => {
	it.each([
		[65_536, 65_536],
		[4_194_304, 4_194_304],
		[8_388_608, 8_388_608],
		[67_108_864, 67_108_864],
		[67_108_865, 67_108_864],
		[Number.MAX_SAFE_INTEGER, 67_108_864],
	])("takes %d as %d: the instance's, up to 64 MiB", async (announced, taken) => {
		const { io } = harness({ fetch: instanceFetch({ ...LIMITS, chunkSize: announced }) });
		expect(await fetchLimits(io, instance)).toMatchObject({ chunkSize: taken });
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
		const client = await connect(without(io, "createClient"), instance);
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
		const withoutSolver = without(io, "solveProofOfWork");
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
		const error = await cliErrorOf(() =>
			proofOfWork(io, instance, createScreen(new Output(), true)),
		);
		expect(error).toMatchObject({
			message: `could not solve the proof of work of ${ORIGIN}: set SECRET_API_KEY to write with a key`,
			exitCode: EXIT.failure,
		});
		expect(error.cause).toBeInstanceOf(TypeError);
	});
});

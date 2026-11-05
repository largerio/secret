import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { type ServerType, serve } from "@hono/node-server";
// Extends Zod with `.openapi()` before `@largerio/secret-shared` builds its
// schemas, which the SDK imports too (the production entry point does the same).
import "@hono/zod-openapi";
import { findNonce, prng, solveProofOfWork } from "@largerio/secret-cli/pow";
import { SecretClient } from "@largerio/secret-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppDatabase, createDatabase } from "../db/index.js";
import { LocalStorage } from "../storage/local.js";
import { createTestApp } from "./testApp.js";

// The command line solves the instance's proof of work itself, as the web
// app's Cap widget does (PROTOCOL.md, "Proof of work"). The format is Cap's,
// which a release of Cap may change: here the command line's solver meets the
// real application, its Cap routes, its rate limit and its token check, over
// HTTP, so that such a change fails a test rather than every write of the
// command line without an API key.

const TEST_DB_PATH = "./data/pow-test.db";
const TEST_FILES_PATH = "./data/pow-test-files";
const SERVER_KEY = randomBytes(32);
// Few and easy challenges, so a test solves them in milliseconds.
const CHALLENGE_COUNT = 4;
const DIFFICULTY = 2;
/** Cap's challenge id and the token it redeems for, as the instance writes them. */
const CHALLENGE_TOKEN = /^[0-9a-f]{50}$/;
const WRITE_TOKEN = /^[0-9a-f]{16}:[0-9a-f]{30}$/;

let sqlite: ReturnType<typeof createDatabase>["sqlite"];
let db: AppDatabase;
const servers: ServerType[] = [];
const stops: Array<() => void> = [];
/** The instance most tests use: the bounds of tests, the challenges above. */
let baseUrl: string;
/** An instance with the bounds of production, to meet its rate limit. */
let limitedUrl: string;

function removeFiles(): void {
	for (const path of [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`]) {
		rmSync(path, { force: true });
	}
	rmSync(TEST_FILES_PATH, { recursive: true, force: true });
}

async function listen(env: Record<string, string>): Promise<string> {
	const { app, stop } = createTestApp({
		db,
		serverKey: SERVER_KEY,
		storage: new LocalStorage(TEST_FILES_PATH),
		env,
	});
	stops.push(stop);
	const port = await new Promise<number>((resolve) => {
		servers.push(
			serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info: AddressInfo) =>
				resolve(info.port),
			),
		);
	});
	return `http://127.0.0.1:${String(port)}`;
}

beforeAll(async () => {
	removeFiles();
	mkdirSync(TEST_FILES_PATH, { recursive: true });
	({ db, sqlite } = createDatabase(TEST_DB_PATH));
	baseUrl = await listen({
		CAP_CHALLENGE_COUNT: String(CHALLENGE_COUNT),
		CAP_DIFFICULTY: String(DIFFICULTY),
	});
	limitedUrl = await listen({
		RATE_LIMIT_MULTIPLIER: "1",
		CAP_CHALLENGE_COUNT: "1",
		CAP_DIFFICULTY: "1",
	});
});

afterAll(async () => {
	await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
	for (const stop of stops) stop();
	sqlite.close();
	removeFiles();
});

interface ServedChallenge {
	readonly challenge: { readonly c: number; readonly s: number; readonly d: number };
	readonly token: string;
	readonly expires: number;
}

async function askChallenge(url: string): Promise<ServedChallenge> {
	const res = await fetch(`${url}/api/cap/challenge`, { method: "POST" });
	expect(res.status).toBe(200);
	return (await res.json()) as ServedChallenge;
}

function redeem(url: string, token: string, solutions: ReadonlyArray<number>): Promise<Response> {
	return fetch(`${url}/api/cap/redeem`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ token, solutions }),
	});
}

/** The solutions of a challenge, found as the command line finds them. */
async function solve({ challenge, token }: ServedChallenge): Promise<number[]> {
	const solutions: number[] = [];
	for (let i = 1; i <= challenge.c; i++) {
		const salt = prng(`${token}${String(i)}`, challenge.s);
		const target = prng(`${token}${String(i)}d`, challenge.d);
		solutions.push(await findNonce(salt, target));
	}
	return solutions;
}

describe("the instance's proof of work, as the command line solves it", () => {
	it("serves Cap's challenge, in the shape the command line reads", async () => {
		const served = await askChallenge(baseUrl);

		expect(served).toEqual({
			challenge: { c: CHALLENGE_COUNT, s: 32, d: DIFFICULTY },
			token: expect.stringMatching(CHALLENGE_TOKEN),
			expires: expect.any(Number),
		});
		// Ten minutes to solve it.
		expect(served.expires - Date.now()).toBeGreaterThan(9 * 60_000);
		expect(served.expires - Date.now()).toBeLessThanOrEqual(10 * 60_000);
	});

	it("checks every solution with the salts and targets of the command line", async () => {
		const served = await askChallenge(baseUrl);
		const solutions = await solve(served);

		const res = await redeem(baseUrl, served.token, solutions);

		expect(res.status).toBe(200);
		const body = (await res.json()) as { expires: number };
		expect(body).toEqual({
			success: true,
			token: expect.stringMatching(WRITE_TOKEN),
			expires: expect.any(Number),
		});
		// Twenty minutes to spend it.
		expect(body.expires - Date.now()).toBeGreaterThan(19 * 60_000);
		expect(body.expires - Date.now()).toBeLessThanOrEqual(20 * 60_000);
	});

	it("redeems a challenge once, right or wrong", async () => {
		const served = await askChallenge(baseUrl);
		const solutions = await solve(served);
		const salt = prng(`${served.token}1`, served.challenge.s);
		const target = prng(`${served.token}1d`, served.challenge.d);
		const sha256 = (nonce: number) =>
			createHash("sha256")
				.update(`${salt}${String(nonce)}`)
				.digest("hex");
		let wrong = 0;
		while (sha256(wrong).startsWith(target)) wrong++;

		const refused = await redeem(baseUrl, served.token, [wrong, ...solutions.slice(1)]);
		expect(refused.status).toBe(400);
		expect(await refused.json()).toEqual({ success: false, message: "Invalid solution" });

		const spent = await redeem(baseUrl, served.token, solutions);
		expect(spent.status).toBe(400);
		expect(await spent.json()).toEqual({
			success: false,
			message: "Challenge invalid or expired",
		});
	});

	it("gives a token that authenticates one write, once", async () => {
		const progress: Array<[number, number]> = [];
		const token = await solveProofOfWork(baseUrl, {
			fetch,
			onProgress: (solved, total) => progress.push([solved, total]),
		});

		expect(token).toMatch(WRITE_TOKEN);
		expect(progress).toEqual([
			[1, 4],
			[2, 4],
			[3, 4],
			[4, 4],
		]);

		const client = await SecretClient.create({ baseUrl });
		const { id, deleteToken } = await client.createNote({ text: "proved", capToken: token });
		expect(await client.checkNote(id)).toMatchObject({ exists: true });

		await expect(client.createNote({ text: "replayed", capToken: token })).rejects.toMatchObject({
			status: 401,
			code: "unauthorized",
		});

		const another = await solveProofOfWork(baseUrl, { fetch });
		await client.deleteNote(id, deleteToken, another);
		expect(await client.checkNote(id)).toMatchObject({ exists: false });
		await expect(client.deleteNote(id, deleteToken, another)).rejects.toMatchObject({
			status: 401,
			code: "unauthorized",
		});
	});

	it("meets the rate limit of /api/cap/*, 60 requests a minute, with the wait it gives", async () => {
		// Challenges and solutions count against the same bound.
		for (let i = 0; i < 30; i++) {
			const served = await askChallenge(limitedUrl);
			const res = await redeem(limitedUrl, served.token, []);
			expect(res.status).toBe(400);
		}

		await expect(solveProofOfWork(limitedUrl, { fetch })).rejects.toMatchObject({
			name: "CliError",
			exitCode: 1,
			message: expect.stringMatching(
				/^http:\/\/127\.0\.0\.1:\d+ takes no more requests from this address for now: try again in \d+[dhms](?: \d+[dhms])?$/,
			),
		});
	});
});

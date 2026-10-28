import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { Agent, request } from "node:http";
import type { AddressInfo } from "node:net";
import { type ServerType, serve } from "@hono/node-server";
// Extends Zod with `.openapi()` before `@largerio/secret-shared` builds its
// schemas, as the routes expect (the production entry point does the same).
import "@hono/zod-openapi";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type AppDatabase, createDatabase } from "../db/index.js";
import { LocalStorage } from "../storage/local.js";
import { createTestApp } from "./testApp.js";

vi.mock("../routes/cap.js", () => ({
	cap: { validateToken: vi.fn(() => Promise.resolve({ success: false })) },
	createCapRoutes: () => new Hono(),
}));

const TEST_DB_PATH = "./data/connection-test.db";
const TEST_FILES_PATH = "./data/connection-test-files";
const CHUNK_SIZE = 64 * 1024;
const API_KEY = randomBytes(32).toString("base64url");

let sqlite: ReturnType<typeof createDatabase>["sqlite"];
let db: AppDatabase;
let server: ServerType;
let baseUrl: string;
let stopApp: () => void;

function removeFiles(): void {
	for (const path of [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`]) {
		rmSync(path, { force: true });
	}
	rmSync(TEST_FILES_PATH, { recursive: true, force: true });
}

beforeAll(async () => {
	removeFiles();
	mkdirSync(TEST_FILES_PATH, { recursive: true });
	({ db, sqlite } = createDatabase(TEST_DB_PATH));
	const { app, stop } = createTestApp({
		db,
		serverKey: randomBytes(32),
		storage: new LocalStorage(TEST_FILES_PATH),
		env: { CHUNK_SIZE: String(CHUNK_SIZE), API_KEY },
	});
	stopApp = stop;
	const port = await new Promise<number>((resolve) => {
		server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info: AddressInfo) =>
			resolve(info.port),
		);
	});
	baseUrl = `http://127.0.0.1:${String(port)}`;
});

afterAll(async () => {
	await new Promise((resolve) => server.close(resolve));
	stopApp();
	sqlite.close();
	removeFiles();
});

// A client that sends a request right after an early error must not lose it.
// The API used to keep such a connection alive, then drop it within 500 ms
// while draining the unread body: undici reused it, and the next request
// failed with "other side closed".
describe("a connection after an error answered before the body was read", () => {
	async function refusedChunk(): Promise<Response> {
		const refused = await fetch(`${baseUrl}/api/v1/notes/upload/abcdefghijklmnopqrstuv/chunks/0`, {
			method: "PUT",
			headers: { "Content-Type": "application/octet-stream" },
			body: new Uint8Array(4 * CHUNK_SIZE),
		});
		await refused.text();
		return refused;
	}

	it.each([0, 100, 300, 450])("serves the next request %i ms later", async (delay) => {
		expect((await refusedChunk()).status).toBe(413);
		await new Promise((resolve) => setTimeout(resolve, delay));

		const next = await fetch(`${baseUrl}/api/health/live`);
		expect(next.status).toBe(200);
	});

	it("serves the next request after a refused write", async () => {
		const refused = await fetch(`${baseUrl}/api/v1/notes`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ encryptedData: "x".repeat(512 * 1024) }),
		});
		expect(refused.status).toBe(401);
		await refused.text();

		const next = await fetch(`${baseUrl}/api/health/live`);
		expect(next.status).toBe(200);
	});
});

describe("createCloseAfterError", () => {
	it("closes after an error to a request with a body", async () => {
		const res = await rawRequest({
			method: "PUT",
			path: "/api/v1/notes/upload/x/chunks/0",
			body: "x",
		});
		expect(res.status).toBe(400);
		expect(res.connection).toBe("close");
	});

	it("keeps the connection after an error to a request without a body", async () => {
		const res = await rawRequest({ method: "GET", path: "/api/v1/nothing-here" });
		expect(res.status).toBe(404);
		expect(res.connection).toBe("keep-alive");
	});

	it("keeps the connection after a success", async () => {
		const res = await rawRequest({
			method: "POST",
			path: "/api/v1/notes",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
			body: JSON.stringify({
				encryptedData: randomBytes(64).toString("base64"),
				clientNonce: randomBytes(24).toString("base64"),
				hasPassword: false,
				expiresIn: 3600,
				maxReads: 1,
				fileCount: 0,
			}),
		});
		expect(res.status).toBe(201);
		expect(res.connection).toBe("keep-alive");
	});
});

/** node:http, which shows the Connection header fetch keeps to itself. */
function rawRequest(options: {
	method: string;
	path: string;
	headers?: Record<string, string>;
	body?: string;
}): Promise<{ status: number; connection: string | undefined }> {
	return new Promise((resolve, reject) => {
		const req = request(
			`${baseUrl}${options.path}`,
			{ method: options.method, headers: options.headers, agent: new Agent({ keepAlive: true }) },
			(res) => {
				res.resume();
				res.on("end", () =>
					resolve({ status: res.statusCode as number, connection: res.headers.connection }),
				);
			},
		);
		req.on("error", reject);
		req.end(options.body);
	});
}

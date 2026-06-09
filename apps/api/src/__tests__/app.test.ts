import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { Hono } from "hono";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
// Import the app factory first: it pulls in `@hono/zod-openapi`, which extends
// Zod with `.openapi()` before `@largerio/shared` schemas are constructed (the
// same ordering the production entry point relies on).
import { createApp } from "../app.js";
import { type AppConfig, parseConfig } from "../config.js";
import { type AppDatabase, createDatabase } from "../db/index.js";
import { LocalStorage } from "../storage/local.js";

// Avoid initializing the real Cap PoW subsystem; app assembly only needs the
// route factory to exist. Auth is covered separately in auth.test.ts.
vi.mock("../routes/cap.js", () => ({
	cap: { validateToken: vi.fn(() => Promise.resolve({ success: true })) },
	createCapRoutes: () => new Hono(),
}));

const TEST_DB_PATH = "./data/app-test.db";
const TEST_FILES_PATH = "./data/app-test-files";
const TEST_SERVER_KEY = randomBytes(32);

function buildConfig(overrides: Partial<AppConfig> = {}): AppConfig {
	// Tiny size limits so oversized-body tests stay cheap to trigger.
	const base = parseConfig({
		SERVER_ENCRYPTION_KEY: "test-key",
		APP_URL: "https://secret.test",
		MAX_FILE_SIZE: "1",
		MAX_FILES_PER_NOTE: "1",
		CHUNK_SIZE: "1",
		MAX_CHUNKED_FILE_SIZE: "10",
	} as NodeJS.ProcessEnv);
	return { ...base, ...overrides };
}

let db: AppDatabase;
let sqlite: ReturnType<typeof createDatabase>["sqlite"];

function makeApp(config: AppConfig = buildConfig()) {
	const storage = new LocalStorage(TEST_FILES_PATH);
	return createApp({ db, serverKey: TEST_SERVER_KEY, storage, config }).app;
}

beforeEach(() => {
	for (const path of [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`]) {
		if (existsSync(path)) rmSync(path);
	}
	if (existsSync(TEST_FILES_PATH)) rmSync(TEST_FILES_PATH, { recursive: true });
	mkdirSync(TEST_FILES_PATH, { recursive: true });
	const created = createDatabase(TEST_DB_PATH);
	db = created.db;
	sqlite = created.sqlite;
});

afterAll(() => {
	sqlite?.close();
	for (const path of [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`]) {
		if (existsSync(path)) rmSync(path);
	}
	if (existsSync(TEST_FILES_PATH)) rmSync(TEST_FILES_PATH, { recursive: true });
});

describe("createApp — unversioned routes", () => {
	it("serves a health check with no-cache", async () => {
		const res = await makeApp().request("/api/health");
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("no-cache");
		expect(await res.json()).toEqual({ status: "ok" });
	});

	it("serves robots.txt referencing the configured appUrl", async () => {
		const res = await makeApp().request("/robots.txt");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/plain");
		expect(res.headers.get("cache-control")).toBe("public, max-age=86400");
		const body = await res.text();
		expect(body).toContain("Disallow: /api/");
		expect(body).toContain("Sitemap: https://secret.test/sitemap.xml");
	});

	it("serves sitemap.xml referencing the configured appUrl", async () => {
		const res = await makeApp().request("/sitemap.xml");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/xml");
		const body = await res.text();
		expect(body).toContain("<loc>https://secret.test/</loc>");
	});

	it("returns a JSON 404 for unknown routes", async () => {
		const res = await makeApp().request("/does-not-exist");
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "Not found" });
	});
});

describe("createApp — versioned API", () => {
	it("exposes runtime config from the parsed AppConfig", async () => {
		const config = buildConfig();
		const res = await makeApp(config).request("/api/v1/config");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			maxFileSize: config.maxFileSize,
			maxFilesPerNote: config.maxFilesPerNote,
			chunkSize: config.chunkSize,
			maxChunkedFileSize: config.maxChunkedFileSize,
		});
	});

	it("serves the OpenAPI 3.1 document", async () => {
		const res = await makeApp().request("/api/v1/openapi.json");
		expect(res.status).toBe(200);
		const doc = (await res.json()) as { openapi: string; info: { title: string } };
		expect(doc.openapi).toBe("3.1.0");
		expect(doc.info.title).toBe("Secret API");
	});

	it("serves the Scalar docs page", async () => {
		const res = await makeApp().request("/api/v1/docs");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
	});

	it("wires the notes routes (exists probe responds)", async () => {
		// A well-formed, non-existent id reaches the mounted exists handler, which
		// answers 200 `{exists:false}` — proving the route is wired (not a miss).
		const res = await makeApp().request("/api/v1/notes/aBcDeFgHiJkL/exists");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ exists: false });
	});
});

describe("createApp — body limits", () => {
	const oversized = "x".repeat(1_200_000); // > maxFileSize*maxFilesPerNote + 1MB

	it("rejects an oversized JSON note with 413", async () => {
		const res = await makeApp().request("/api/v1/notes", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: oversized,
		});
		expect(res.status).toBe(413);
		expect(await res.json()).toEqual({ error: "Payload too large" });
	});

	it("rejects an oversized multipart upload with 413", async () => {
		const res = await makeApp().request("/api/v1/notes/upload", {
			method: "POST",
			body: oversized,
		});
		expect(res.status).toBe(413);
		expect(await res.json()).toEqual({ error: "Payload too large" });
	});

	it("rejects an oversized chunk with 413", async () => {
		const res = await makeApp().request("/api/v1/notes/upload/session-id/chunks/0", {
			method: "PUT",
			body: "x".repeat(4096), // > chunkSize + 1024
		});
		expect(res.status).toBe(413);
		expect(await res.json()).toEqual({ error: "Chunk too large" });
	});
});

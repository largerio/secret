import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { Hono } from "hono";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
// Import the app factory first: it pulls in `@hono/zod-openapi`, which extends
// Zod with `.openapi()` before `@largerio/secret-shared` schemas are constructed (the
// same ordering the production entry point relies on).
import { createApp } from "../app.js";
import { type AppConfig, parseConfig } from "../config.js";
import { type AppDatabase, createDatabase } from "../db/index.js";
import { DEFAULT_BODY_LIMIT } from "../middleware/bodyLimit.js";
import { LocalStorage } from "../storage/local.js";
import { problemOf } from "./problems.js";

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
		SERVER_ENCRYPTION_KEY: TEST_SERVER_KEY.toString("base64"),
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

const UNKNOWN = { version: "unknown", revision: "unknown" };

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

describe("createApp — health probes", () => {
	it("reports healthy when the database and storage respond", async () => {
		const res = await makeApp().request("/api/health");
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(await res.json()).toEqual({
			status: "ok",
			checks: { database: "ok", storage: "ok" },
			storage: { quotaBytes: null },
			...UNKNOWN,
		});
	});

	it("reports the build and the quota, never the volume stored", async () => {
		const storage = new LocalStorage(TEST_FILES_PATH);
		const build = { version: "1.4.1-dev", revision: "0123456789abcdef0123456789abcdef01234567" };
		const app = createApp({
			db,
			serverKey: TEST_SERVER_KEY,
			storage,
			config: buildConfig({ storageQuotaBytes: 5000 }),
			build,
		}).app;

		const body = (await (await app.request("/api/health")).json()) as Record<string, unknown>;

		expect(body).toMatchObject({ storage: { quotaBytes: 5000 }, ...build });
		expect(JSON.stringify(body)).not.toContain("usedBytes");
	});

	it("answers liveness without touching the database or the storage", async () => {
		const storage = new LocalStorage(TEST_FILES_PATH);
		const probe = vi.spyOn(storage, "probe").mockRejectedValue(new Error("bucket unreachable"));
		const app = createApp({ db, serverKey: TEST_SERVER_KEY, storage, config: buildConfig() }).app;
		sqlite.close();

		const res = await app.request("/api/health/live");

		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(await res.json()).toEqual({ status: "ok" });
		expect(probe).not.toHaveBeenCalled();
	});

	it("answers readiness from the database and the storage", async () => {
		const res = await makeApp().request("/api/health/ready");

		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(await res.json()).toEqual({
			status: "ok",
			checks: { database: "ok", storage: "ok" },
		});
	});

	it("turns readiness and /api/health to 503 once the drain begins, not liveness", async () => {
		const storage = new LocalStorage(TEST_FILES_PATH);
		const { app, drain } = createApp({
			db,
			serverKey: TEST_SERVER_KEY,
			storage,
			config: buildConfig(),
		});
		expect((await app.request("/api/health/ready")).status).toBe(200);

		drain();

		const ready = await app.request("/api/health/ready");
		expect(ready.status).toBe(503);
		expect(await ready.json()).toEqual({
			status: "draining",
			checks: { database: "ok", storage: "ok" },
		});
		const health = await app.request("/api/health");
		expect(health.status).toBe(503);
		expect(await health.json()).toMatchObject({ status: "draining" });
		expect((await app.request("/api/health/live")).status).toBe(200);
	});

	it("keeps every probe out of the request log", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

		const app = makeApp();
		for (const path of ["/api/health", "/api/health/live", "/api/health/ready"]) {
			await app.request(path);
		}

		expect(logSpy).not.toHaveBeenCalled();
		logSpy.mockRestore();
	});

	it("reports 503 when the storage backend is unreachable", async () => {
		const storage = new LocalStorage(TEST_FILES_PATH);
		vi.spyOn(storage, "probe").mockRejectedValue(new Error("bucket unreachable"));
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

		const app = createApp({ db, serverKey: TEST_SERVER_KEY, storage, config: buildConfig() }).app;
		const res = await app.request("/api/health");

		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({
			status: "degraded",
			checks: { database: "ok", storage: "error" },
			storage: { quotaBytes: null },
			...UNKNOWN,
		});
		expect((await app.request("/api/health/ready")).status).toBe(503);
		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining('"msg":"storage probe failed","detail":"bucket unreachable"'),
		);
		consoleSpy.mockRestore();
	});

	it("reports 503 when the database is closed", async () => {
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const app = makeApp();
		sqlite.close();

		const res = await app.request("/api/health");

		expect(res.status).toBe(503);
		expect((await res.json()).checks.database).toBe("error");
		consoleSpy.mockRestore();
	});
});

describe("createApp — unversioned routes", () => {
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

	it("allows CORS from APP_URL's origin, whatever its trailing slash", async () => {
		const config = parseConfig({
			SERVER_ENCRYPTION_KEY: TEST_SERVER_KEY.toString("base64"),
			APP_URL: "https://secret.test/",
		} as NodeJS.ProcessEnv);

		const res = await makeApp(config).request("/api/v1/config", {
			headers: { Origin: "https://secret.test" },
		});

		expect(res.headers.get("access-control-allow-origin")).toBe("https://secret.test");
	});

	it("returns a JSON 404 for unknown routes", async () => {
		const res = await makeApp().request("/does-not-exist");
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual(problemOf(404, "not_found", "Not found"));
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
			maxExpiry: config.maxExpirySeconds,
			chunkSize: config.chunkSize,
			maxChunkedFileSize: config.maxChunkedFileSize,
		});
	});

	it("serves the OpenAPI 3.1 document", async () => {
		const res = await makeApp().request("/api/v1/openapi.json");
		expect(res.status).toBe(200);
		const doc = (await res.json()) as {
			openapi: string;
			info: { title: string; version: string };
			paths: Record<string, unknown>;
		};
		expect(doc.openapi).toBe("3.1.0");
		expect(doc.info.title).toBe("Secret API");
		expect(doc.info.version).toBe("unknown");
		// Every notes endpoint must be documented, including the binary/multipart
		// ones whose handlers validate manually.
		expect(Object.keys(doc.paths)).toEqual(
			expect.arrayContaining([
				"/notes",
				"/notes/upload",
				"/notes/{id}",
				"/notes/{id}/exists",
				"/notes/{id}/raw",
				"/notes/{id}/stream",
				"/notes/upload/init",
				"/notes/upload/{uploadId}/chunks/{index}",
				"/notes/upload/{uploadId}/complete",
			]),
		);
	});

	it("gives the OpenAPI document the build's version", async () => {
		const storage = new LocalStorage(TEST_FILES_PATH);
		const app = createApp({
			db,
			serverKey: TEST_SERVER_KEY,
			storage,
			config: buildConfig(),
			build: { version: "1.4.1", revision: "unknown" },
		}).app;

		const doc = (await (await app.request("/api/v1/openapi.json")).json()) as {
			info: { version: string };
		};

		expect(doc.info.version).toBe("1.4.1");
	});

	it("documents every route's errors as problem details", async () => {
		const res = await makeApp().request("/api/v1/openapi.json");
		const doc = (await res.json()) as {
			paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
			components: { schemas: Record<string, unknown> };
		};

		expect(doc.components.schemas["Problem"]).toBeDefined();
		for (const [path, operations] of Object.entries(doc.paths)) {
			for (const [method, operation] of Object.entries(operations)) {
				expect(operation.responses["default"], `${method} ${path}`).toEqual({
					content: {
						"application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } },
					},
					description: "An error, named by its `code` (PROTOCOL.md, Errors)",
				});
			}
		}
	});

	it("documents readCount on the exists response", async () => {
		const res = await makeApp().request("/api/v1/openapi.json");
		const doc = (await res.json()) as {
			paths: Record<string, Record<string, unknown>>;
		};
		const ok = doc.paths["/notes/{id}/exists"]?.["get"] as {
			responses: { 200: { content: { "application/json": { schema: { anyOf: unknown[] } } } } };
		};
		const [found] = ok.responses[200].content["application/json"].schema.anyOf as {
			required: string[];
			properties: Record<string, { type: string; minimum?: number; description?: string }>;
		}[];

		expect(found?.required).toContain("readCount");
		expect(found?.properties["readCount"]).toMatchObject({ type: "integer", minimum: 0 });
		expect(found?.properties["readCount"]?.description).toContain("maxReads - readCount");
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
		expect(await res.json()).toEqual(problemOf(413, "payload_too_large", "Payload too large"));
	});

	it("rejects an oversized multipart upload with 413", async () => {
		const res = await makeApp().request("/api/v1/notes/upload", {
			method: "POST",
			body: oversized,
		});
		expect(res.status).toBe(413);
		expect(await res.json()).toEqual(problemOf(413, "payload_too_large", "Payload too large"));
	});

	it("rejects an oversized upload init with 413", async () => {
		const res = await makeApp().request("/api/v1/notes/upload/init", {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Cap-Token": "valid" },
			body: "x".repeat(DEFAULT_BODY_LIMIT + 1),
		});
		expect(res.status).toBe(413);
		expect(await res.json()).toEqual(problemOf(413, "payload_too_large", "Payload too large"));
	});

	it("rejects an oversized Cap request before reading it", async () => {
		const res = await makeApp().request("/api/cap/redeem", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Content-Length": String(DEFAULT_BODY_LIMIT + 1),
			},
			body: "x".repeat(DEFAULT_BODY_LIMIT + 1),
		});
		expect(res.status).toBe(413);
	});

	it("rejects an oversized chunk with 413", async () => {
		const res = await makeApp().request("/api/v1/notes/upload/session-id/chunks/0", {
			method: "PUT",
			body: "x".repeat(4096), // > chunkSize + 1024
		});
		expect(res.status).toBe(413);
		expect(await res.json()).toEqual(problemOf(413, "chunk_too_large", "Chunk too large"));
	});
});

describe("createApp — rate limits", () => {
	it("counts a JSON create once against the create bound", async () => {
		// The create bound is 30 a minute; a 0.1 multiplier rounds it up to 3.
		const app = makeApp(buildConfig({ rateLimitMultiplier: 0.1 }));
		const create = () =>
			app.request("/api/v1/notes", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{}",
			});

		for (let i = 0; i < 3; i++) {
			expect((await create()).status).not.toBe(429);
		}
		expect((await create()).status).toBe(429);
	});
});

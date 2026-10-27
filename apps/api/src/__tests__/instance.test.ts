import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
// Extends Zod with `.openapi()` before `@largerio/secret-shared` builds its
// schemas, as the routes expect (the production entry point does the same).
import "@hono/zod-openapi";
import { Hono } from "hono";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../config.js";
import { type AppDatabase, createDatabase } from "../db/index.js";
import { type Instance, startInstance } from "../instance.js";
import { RECONCILE_FIRST_RUN_MS } from "../reconcile.js";
import type { StorageBackend } from "../storage/interface.js";
import { stubStorage } from "./storageDoubles.js";

vi.mock("../routes/cap.js", () => ({
	cap: { validateToken: vi.fn(() => Promise.resolve({ success: false })) },
	createCapRoutes: () => new Hono(),
}));

const TEST_DB_PATH = "./data/instance-test.db";
const SERVER_KEY = randomBytes(32);
const API_KEY = "k".repeat(32);
const METRICS_TOKEN = "m".repeat(32);
const DELETE_TOKEN = "d".repeat(32);
const CLEANUP_INTERVAL_MS = 60_000;
const BUILD = { version: "1.4.1-dev", revision: "137e9fa" };

let db: AppDatabase;
let sqlite: DatabaseSync;
let instance: Instance | undefined;

function removeTestFiles(): void {
	for (const path of [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`]) {
		rmSync(path, { force: true });
	}
}

beforeEach(() => {
	removeTestFiles();
	mkdirSync("./data", { recursive: true });
	({ db, sqlite } = createDatabase(TEST_DB_PATH));
	vi.useFakeTimers();
	// The cleanup job and the request logger write to the console.
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	if (instance) {
		instance.stopJobs();
		for (const limiter of instance.rateLimiters) {
			limiter.cleanup();
		}
		instance = undefined;
	}
	vi.useRealTimers();
	vi.restoreAllMocks();
	sqlite.close();
});

afterAll(() => {
	removeTestFiles();
});

function start(backend: StorageBackend, env: Record<string, string> = {}): Instance {
	const config = parseConfig({
		SERVER_ENCRYPTION_KEY: SERVER_KEY.toString("base64"),
		APP_URL: "https://secret.test",
		API_KEY,
		METRICS_TOKEN,
		CLEANUP_INTERVAL_MS: String(CLEANUP_INTERVAL_MS),
		...env,
	} as NodeJS.ProcessEnv);
	instance = startInstance({ db, serverKey: SERVER_KEY, config, build: BUILD, backend });
	return instance;
}

/** A file note, its payload in the storage; `expiresAt` in milliseconds. */
function insertFileNote(id: string, expiresAt: number): void {
	sqlite
		.prepare(
			`INSERT INTO notes (id, encrypted_data, server_nonce, client_nonce, delete_token,
			  file_count, file_path, expires_at, created_at, size_bytes)
			 VALUES (?, x'', 'iv', 'nonce', ?, 1, ?, ?, 1, 10)`,
		)
		.run(id, DELETE_TOKEN, id, Math.floor(expiresAt / 1000));
}

function noteCount(): number {
	return Number(sqlite.prepare("SELECT COUNT(*) AS n FROM notes").get()?.["n"]);
}

async function scrape(app: Instance["app"]): Promise<string> {
	const res = await app.request("/api/metrics", {
		headers: { Authorization: `Bearer ${METRICS_TOKEN}` },
	});
	expect(res.status).toBe(200);
	return res.text();
}

/** The value of one sample line, e.g. `secret_notes{type="file"}`. */
function sample(text: string, series: string): number | undefined {
	const line = text.split("\n").find((candidate) => candidate.startsWith(`${series} `));
	return line === undefined ? undefined : Number(line.slice(series.length + 1));
}

describe("startInstance", () => {
	it("counts the jobs and every purge in the registry /api/metrics serves", async () => {
		const backend = stubStorage();
		insertFileNote("expiredNote1", Date.now() - 60_000);
		insertFileNote("deletedNote1", Date.now() + 3_600_000);
		const { app } = start(backend);
		expect(backend.claim).toHaveBeenCalledOnce();

		// The cleanup job deletes the expired note and purges its file.
		await vi.advanceTimersByTimeAsync(CLEANUP_INTERVAL_MS);
		// A route purges through the same storage.
		const res = await app.request("/api/v1/notes/deletedNote1", {
			method: "DELETE",
			headers: { Authorization: `Bearer ${API_KEY}`, "X-Delete-Token": DELETE_TOKEN },
		});
		expect(res.status).toBe(200);
		// The storage sweep, on its trial day: claimed at boot.
		await vi.advanceTimersByTimeAsync(RECONCILE_FIRST_RUN_MS - CLEANUP_INTERVAL_MS);

		expect(backend.purge).toHaveBeenCalledTimes(2);
		expect(backend.list).toHaveBeenCalledOnce();
		const text = await scrape(app);
		expect(sample(text, "secret_notes_expired_total")).toBe(1);
		expect(sample(text, "secret_notes_deleted_total")).toBe(1);
		expect(sample(text, 'secret_storage_purges_total{result="ok"}')).toBe(2);
		expect(sample(text, 'secret_storage_sweep_last_status{status="trial"}')).toBe(1);
		expect(text).toContain(`secret_build_info{version="1.4.1-dev",revision="137e9fa"} 1\n`);
	});

	it("hands its caller the storage, its purges counted", async () => {
		const backend = stubStorage();
		const { app, storage } = start(backend);

		await storage.purge("someNoteId01");

		expect(backend.purge).toHaveBeenCalledWith("someNoteId01");
		expect(sample(await scrape(app), 'secret_storage_purges_total{result="ok"}')).toBe(1);
	});

	it("stops both jobs", async () => {
		const backend = stubStorage();
		const { stopJobs } = start(backend);
		insertFileNote("expiredNote1", Date.now() - 60_000);

		stopJobs();
		await vi.advanceTimersByTimeAsync(RECONCILE_FIRST_RUN_MS + CLEANUP_INTERVAL_MS);

		expect(noteCount()).toBe(1);
		expect(backend.list).not.toHaveBeenCalled();
	});

	it("claims the storage but never sweeps it with STORAGE_RECONCILE=false", async () => {
		const backend = stubStorage();
		const { app } = start(backend, { STORAGE_RECONCILE: "false" });

		await vi.advanceTimersByTimeAsync(RECONCILE_FIRST_RUN_MS);

		expect(backend.claim).toHaveBeenCalledOnce();
		expect(backend.list).not.toHaveBeenCalled();
		expect(await scrape(app)).not.toContain("secret_storage_sweep_last_status{");
	});
});

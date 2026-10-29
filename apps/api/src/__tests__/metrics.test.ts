import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
// Extends Zod with `.openapi()` before `@largerio/secret-shared` builds its
// schemas, as the routes expect (the production entry point does the same).
import "@hono/zod-openapi";
import { SECRETSTREAM_ABYTES } from "@largerio/secret-crypto";
import { BODY_FLOOR, encodeEnvelope, MAX_PASSWORD_ATTEMPTS } from "@largerio/secret-shared";
import { Hono } from "hono";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
// First: it pulls in `@hono/zod-openapi`, which extends Zod before the shared
// schemas are built (see app.test.ts).
import { createApp } from "../app.js";
import { parseConfig } from "../config.js";
import { type AppDatabase, createDatabase } from "../db/index.js";
import { createLogger } from "../logger.js";
import { type AppMetrics, countPurges, createMetrics } from "../metrics.js";
import { getStorageUsedBytes } from "../quota.js";
import type { StorageBackend } from "../storage/index.js";
import { LocalStorage } from "../storage/local.js";
import { stubStorage } from "./storageDoubles.js";

vi.mock("../routes/cap.js", () => ({
	cap: { validateToken: vi.fn(() => Promise.resolve({ success: false })) },
	createCapRoutes: () => new Hono(),
}));

const TEST_DB_PATH = "./data/metrics-test.db";
const TEST_FILES_PATH = "./data/metrics-test-files";
const SERVER_KEY = randomBytes(32);
const API_KEY = "k".repeat(32);
const METRICS_TOKEN = "m".repeat(32);
const BUILD = { version: "1.4.1-dev", revision: "137e9fa2d3a255df7e7557690f025d34857e4443" };

let db: AppDatabase;
let sqlite: DatabaseSync;

function removeTestFiles(): void {
	for (const path of [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`]) {
		rmSync(path, { force: true });
	}
	rmSync(TEST_FILES_PATH, { recursive: true, force: true });
}

beforeEach(() => {
	try {
		sqlite?.close();
	} catch {
		/* closed by the test itself */
	}
	removeTestFiles();
	mkdirSync(TEST_FILES_PATH, { recursive: true });
	({ db, sqlite } = createDatabase(TEST_DB_PATH));
});

afterAll(() => {
	try {
		sqlite.close();
	} catch {
		/* closed by the test itself */
	}
	removeTestFiles();
});

function metricsWith(options: { quotaBytes?: number; now?: () => number } = {}) {
	const lines: string[] = [];
	const logger = createLogger({ write: (_level, line) => lines.push(line) });
	const metrics = createMetrics({
		db,
		build: BUILD,
		quotaBytes: options.quotaBytes ?? 0,
		logger,
		...(options.now ? { now: options.now } : {}),
	});
	return { metrics, lines };
}

/** The value of one sample line, e.g. `secret_notes{type="file"}`. */
function sample(text: string, series: string): number | undefined {
	const line = text.split("\n").find((candidate) => candidate.startsWith(`${series} `));
	return line === undefined ? undefined : Number(line.slice(series.length + 1));
}

describe("createMetrics", () => {
	it("exposes the build, the process and every counter from the start", () => {
		const text = metricsWith().metrics.render();

		expect(text).toContain(
			`secret_build_info{version="1.4.1-dev",revision="${BUILD.revision}"} 1\n`,
		);
		expect(sample(text, "secret_process_start_time_seconds")).toBeGreaterThan(1_700_000_000);
		expect(sample(text, "secret_process_resident_memory_bytes")).toBeGreaterThan(0);
		expect(sample(text, "secret_process_heap_used_bytes")).toBeGreaterThan(0);
		for (const type of ["text", "file", "chunked"]) {
			expect(sample(text, `secret_notes_created_total{type="${type}"}`)).toBe(0);
			expect(sample(text, `secret_note_reads_total{type="${type}"}`)).toBe(0);
			expect(sample(text, `secret_notes{type="${type}"}`)).toBe(0);
		}
		for (const series of [
			"secret_notes_burned_total",
			"secret_notes_attempts_exhausted_total",
			'secret_read_proofs_refused_total{proof="link"}',
			'secret_read_proofs_refused_total{proof="password"}',
			"secret_notes_deleted_total",
			"secret_notes_expired_total",
			'secret_storage_purges_total{result="ok"}',
			'secret_storage_purges_total{result="error"}',
			"secret_pending_deletions_abandoned_total",
			"secret_upload_sessions",
			"secret_storage_used_bytes",
			'secret_pending_deletions{state="queued"}',
			'secret_pending_deletions{state="retrying"}',
		]) {
			expect(sample(text, series)).toBe(0);
		}
		// No quota configured, no quota gauge; no sweep yet, no sweep sample.
		expect(text).not.toContain("secret_storage_quota_bytes");
		expect(text).toContain("# TYPE secret_storage_sweep_last_run_timestamp_seconds gauge\n#");
	});

	it("exposes the quota when one is set", () => {
		const text = metricsWith({ quotaBytes: 5000 }).metrics.render();

		expect(sample(text, "secret_storage_quota_bytes")).toBe(5000);
	});

	it("reads the notes, uploads, usage and owed purges from the database", () => {
		const insertNote = sqlite.prepare(
			`INSERT INTO notes (id, encrypted_data, server_nonce, client_nonce, delete_token,
			  file_path, chunk_count, expires_at, created_at, size_bytes)
			 VALUES (?, x'', 'iv', 'nonce', 'token', ?, ?, 9999999999999, 1, ?)`,
		);
		insertNote.run("textNote0001", null, null, 100);
		insertNote.run("textNote0002", null, 0, 50);
		insertNote.run("fileNote0001", "fileNote0001", null, 1000);
		insertNote.run("chunkNote001", null, 3, 2000);
		sqlite
			.prepare(
				`INSERT INTO uploads (id, metadata, chunk_count, note_id, delete_token, created_at, expires_at)
				 VALUES ('upload0000000000000001', '{}', 2, 'pendingNote1', 'token', 1, 9999999999999)`,
			)
			.run();
		sqlite
			.prepare(
				`INSERT INTO upload_chunks (upload_id, chunk_index, size_bytes)
				 VALUES ('upload0000000000000001', 0, 300), ('upload0000000000000001', 1, 7)`,
			)
			.run();
		const insertDeletion = sqlite.prepare(
			"INSERT INTO pending_deletions (note_id, attempts, next_retry_at, created_at) VALUES (?, ?, 1, 1)",
		);
		insertDeletion.run("goneNote0001", 0);
		insertDeletion.run("goneNote0002", 0);
		insertDeletion.run("goneNote0003", 2);

		const text = metricsWith().metrics.render();

		expect(sample(text, 'secret_notes{type="text"}')).toBe(2);
		expect(sample(text, 'secret_notes{type="file"}')).toBe(1);
		expect(sample(text, 'secret_notes{type="chunked"}')).toBe(1);
		expect(sample(text, "secret_upload_sessions")).toBe(1);
		// The notes, then the chunks of the upload in progress: what the quota counts.
		expect(sample(text, "secret_storage_used_bytes")).toBe(3457);
		expect(getStorageUsedBytes(db)).toBe(3457);
		expect(sample(text, 'secret_pending_deletions{state="queued"}')).toBe(2);
		expect(sample(text, 'secret_pending_deletions{state="retrying"}')).toBe(1);
		expect(text).not.toMatch(/Note000|goneNote|upload0000/);
	});

	it("leaves out what the database holds when it cannot be read, and logs why", () => {
		const { metrics, lines } = metricsWith();
		expect(metrics.render()).toContain("secret_upload_sessions 0");
		sqlite.close();

		const text = metrics.render();

		for (const family of ["secret_notes", "secret_upload_sessions", "secret_storage_used_bytes"]) {
			expect(text).toContain(`# TYPE ${family} gauge\n#`);
		}
		expect(text).not.toContain("secret_pending_deletions{");
		expect(text).toContain("secret_build_info{");
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain('"msg":"metrics could not read the database","detail":"');
	});

	it("labels requests by method, route pattern and status class", () => {
		const { metrics } = metricsWith();

		metrics.recordRequest({
			method: "GET",
			route: "/api/v1/notes/:id",
			status: 200,
			seconds: 0.02,
		});
		metrics.recordRequest({
			method: "GET",
			route: "/api/v1/notes/:id",
			status: 404,
			seconds: 0.002,
		});
		metrics.recordRequest({ method: "PROPFIND", route: "/*", status: 404, seconds: 0.001 });

		const text = metrics.render();
		expect(
			sample(
				text,
				'secret_http_requests_total{method="GET",route="/api/v1/notes/:id",status="2xx"}',
			),
		).toBe(1);
		expect(
			sample(
				text,
				'secret_http_requests_total{method="GET",route="/api/v1/notes/:id",status="4xx"}',
			),
		).toBe(1);
		expect(sample(text, 'secret_http_requests_total{method="other",route="/*",status="4xx"}')).toBe(
			1,
		);
		expect(
			sample(
				text,
				'secret_http_request_duration_seconds_bucket{method="GET",route="/api/v1/notes/:id",le="0.005"}',
			),
		).toBe(1);
		expect(
			sample(
				text,
				'secret_http_request_duration_seconds_count{method="GET",route="/api/v1/notes/:id"}',
			),
		).toBe(2);
	});

	it("counts the life of notes and of their purges", () => {
		const { metrics } = metricsWith();

		metrics.noteCreated("chunked");
		metrics.noteRead("file", false);
		metrics.noteRead("text", true);
		metrics.proofRefused("link", false);
		metrics.proofRefused("password", false);
		metrics.proofRefused("password", true);
		metrics.noteDeleted();
		metrics.notesExpired(3);
		metrics.purgeSettled("ok");
		metrics.purgeSettled("error");
		metrics.deletionsAbandoned(2);

		const text = metrics.render();
		expect(sample(text, 'secret_notes_created_total{type="chunked"}')).toBe(1);
		expect(sample(text, 'secret_note_reads_total{type="file"}')).toBe(1);
		expect(sample(text, 'secret_note_reads_total{type="text"}')).toBe(1);
		expect(sample(text, "secret_notes_burned_total")).toBe(1);
		expect(sample(text, 'secret_read_proofs_refused_total{proof="link"}')).toBe(1);
		expect(sample(text, 'secret_read_proofs_refused_total{proof="password"}')).toBe(2);
		expect(sample(text, "secret_notes_attempts_exhausted_total")).toBe(1);
		expect(sample(text, "secret_notes_deleted_total")).toBe(1);
		expect(sample(text, "secret_notes_expired_total")).toBe(3);
		expect(sample(text, 'secret_storage_purges_total{result="ok"}')).toBe(1);
		expect(sample(text, 'secret_storage_purges_total{result="error"}')).toBe(1);
		expect(sample(text, "secret_pending_deletions_abandoned_total")).toBe(2);
	});

	it("keeps how the last sweep ended, when, and the orphans of the last one that ran", () => {
		let clock = 1_700_000_000_000;
		const { metrics } = metricsWith({ now: () => clock });
		const status = (text: string) =>
			["done", "trial", "skipped", "failed"].map((s) =>
				sample(text, `secret_storage_sweep_last_status{status="${s}"}`),
			);

		metrics.sweepFinished({ status: "trial", scanned: 9, orphans: 4 });
		let text = metrics.render();
		expect(sample(text, "secret_storage_sweep_last_run_timestamp_seconds")).toBe(1_700_000_000);
		expect(status(text)).toEqual([0, 1, 0, 0]);
		expect(sample(text, "secret_storage_sweep_last_orphans")).toBe(4);

		clock += 86_400_000;
		metrics.sweepFinished({ status: "done", scanned: 9, purged: 3, failed: 1 });
		text = metrics.render();
		expect(sample(text, "secret_storage_sweep_last_run_timestamp_seconds")).toBe(1_700_086_400);
		expect(status(text)).toEqual([1, 0, 0, 0]);
		expect(sample(text, "secret_storage_sweep_last_orphans")).toBe(4);

		metrics.sweepFinished({ status: "skipped", otherInstances: ["other-instance-id"] });
		text = metrics.render();
		expect(status(text)).toEqual([0, 0, 1, 0]);
		expect(sample(text, "secret_storage_sweep_last_orphans")).toBe(4);
		expect(text).not.toContain("other-instance-id");

		metrics.sweepFinished({ status: "failed" });
		expect(status(metrics.render())).toEqual([0, 0, 0, 1]);
	});
});

describe("countPurges", () => {
	function recorder(): { metrics: AppMetrics; results: string[] } {
		const results: string[] = [];
		const metrics = { purgeSettled: (result: string) => results.push(result) };
		return { metrics: metrics as unknown as AppMetrics, results };
	}

	it("counts each purge by result, and still rejects a failed one", async () => {
		const { metrics, results } = recorder();
		const failure = new Error("bucket unreachable");
		const purge = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(failure);
		const storage = countPurges(stubStorage({ purge }), metrics);

		await storage.purge("noteId000001");
		await expect(storage.purge("noteId000002")).rejects.toBe(failure);

		expect(results).toEqual(["ok", "error"]);
		expect(purge).toHaveBeenCalledWith("noteId000002");
	});

	it("passes every other call through to the backend", async () => {
		const backend = new LocalStorage(TEST_FILES_PATH);
		const storage = countPurges(backend, recorder().metrics);

		const key = await storage.save("noteId000003", Buffer.from("file"));
		await storage.saveChunk("noteId000004", 0, Buffer.from("chunk"));
		await storage.claim("instance-one");
		await storage.probe?.();
		await storage.close?.();

		expect((await storage.read(key)).toString()).toBe("file");
		expect((await storage.readChunk("noteId000004", 0)).toString()).toBe("chunk");
		expect(await storage.listClaims()).toEqual(["instance-one"]);
		const listed: string[] = [];
		for await (const stored of storage.list()) {
			listed.push(stored.noteId);
		}
		expect(listed.sort()).toEqual(["noteId000003", "noteId000004"]);
	});

	it("passes probe and close on with the backend as `this`, and only when it has them", async () => {
		const calls: unknown[] = [];
		const backend: StorageBackend = {
			...stubStorage(),
			async probe() {
				calls.push(this);
			},
			async close() {
				calls.push(this);
			},
		};

		const storage = countPurges(backend, recorder().metrics);
		await storage.probe?.();
		await storage.close?.();

		expect(calls).toEqual([backend, backend]);
		const bare = countPurges(stubStorage(), recorder().metrics);
		expect(bare).not.toHaveProperty("probe");
		expect(bare).not.toHaveProperty("close");
	});
});

describe("GET /api/metrics", () => {
	function makeApp(env: Record<string, string> = {}) {
		const config = parseConfig({
			SERVER_ENCRYPTION_KEY: SERVER_KEY.toString("base64"),
			APP_URL: "https://secret.test",
			API_KEY,
			METRICS_TOKEN,
			...env,
		} as NodeJS.ProcessEnv);
		const lines: string[] = [];
		const logger = createLogger({ write: (_level, line) => lines.push(line) });
		const storage = new LocalStorage(TEST_FILES_PATH);
		const { app } = createApp({ db, serverKey: SERVER_KEY, storage, config, logger, build: BUILD });
		return { app, lines };
	}

	function scrape(
		app: ReturnType<typeof createApp>["app"],
		authorization = `Bearer ${METRICS_TOKEN}`,
	) {
		return app.request("/api/metrics", { headers: { Authorization: authorization } });
	}

	it("is a 404, like any unknown route, while METRICS_TOKEN is unset", async () => {
		const { app } = makeApp({ METRICS_TOKEN: "" });

		const res = await scrape(app);

		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "Not found" });
	});

	it("refuses a scrape without the token or with another one", async () => {
		const { app } = makeApp();

		const bare = await app.request("/api/metrics");
		expect(bare.status).toBe(401);

		for (const authorization of [
			"",
			`Bearer ${"x".repeat(32)}`,
			`Bearer ${METRICS_TOKEN.slice(1)}`,
			`Bearer ${API_KEY}`,
		]) {
			const res = await scrape(app, authorization);
			expect(res.status).toBe(401);
			expect(res.headers.get("www-authenticate")).toBe('Bearer realm="metrics"');
			expect(await res.json()).toEqual({ error: "Unauthorized" });
		}
	});

	it("serves the text format to the token, uncached, and logs only the failed scrapes", async () => {
		const { app, lines } = makeApp();

		const res = await scrape(app, `bearer ${METRICS_TOKEN}`);

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
		expect(res.headers.get("cache-control")).toBe("no-store");
		const text = await res.text();
		expect(text.startsWith("# HELP secret_build_info ")).toBe(true);
		expect(text.endsWith("\n")).toBe(true);
		expect(lines).toHaveLength(0);

		await scrape(app, "Bearer wrong");
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain('"route":"/api/metrics","status":401');
	});

	it("counts real traffic by note type and route pattern, and names no note", async () => {
		const { app } = makeApp();
		const auth = { Authorization: `Bearer ${API_KEY}` };
		const nonce = Buffer.from("test-nonce-24-bytes!!!!").toString("base64");
		const secrets: string[] = [];

		async function createJson(options: { maxReads: number; fileCount: number }) {
			const res = await app.request("/api/v1/notes", {
				method: "POST",
				headers: { ...auth, "Content-Type": "application/json" },
				body: JSON.stringify({
					encryptedData: Buffer.from("ciphertext").toString("base64"),
					clientNonce: nonce,
					hasPassword: false,
					expiresIn: 3600,
					...options,
				}),
			});
			expect(res.status).toBe(201);
			const note = (await res.json()) as { id: string; deleteToken: string };
			secrets.push(note.id, note.deleteToken);
			return note;
		}

		// A text note burned by its only read.
		const burned = await createJson({ maxReads: 1, fileCount: 0 });
		expect((await app.request(`/api/v1/notes/${burned.id}`)).status).toBe(200);

		// A file note sent as JSON, which /:id serves like a text note.
		const jsonFile = await createJson({ maxReads: 0, fileCount: 1 });
		expect((await app.request(`/api/v1/notes/${jsonFile.id}`)).status).toBe(200);
		expect((await app.request(`/api/v1/notes/${jsonFile.id}/exists`)).status).toBe(200);

		// A file note, burned by its only read, raw.
		const form = new FormData();
		form.append(
			"metadata",
			JSON.stringify({
				clientNonce: nonce,
				hasPassword: false,
				expiresIn: 3600,
				maxReads: 1,
				fileCount: 1,
			}),
		);
		form.append("data", new Blob([Buffer.from("file-ciphertext")] as BlobPart[]));
		const fileRes = await app.request("/api/v1/notes/upload", {
			method: "POST",
			headers: auth,
			body: form,
		});
		const file = (await fileRes.json()) as { id: string; deleteToken: string };
		secrets.push(file.id, file.deleteToken);
		expect((await app.request(`/api/v1/notes/${file.id}/raw`)).status).toBe(200);

		// A text note deleted with its token.
		const deleted = await createJson({ maxReads: 0, fileCount: 0 });
		const del = await app.request(`/api/v1/notes/${deleted.id}`, {
			method: "DELETE",
			headers: { ...auth, "X-Delete-Token": deleted.deleteToken },
		});
		expect(del.status).toBe(200);

		// A chunked note, burned by its only read, streamed.
		const init = await app.request("/api/v1/notes/upload/init", {
			method: "POST",
			headers: { ...auth, "Content-Type": "application/json" },
			body: JSON.stringify({
				streamHeader: Buffer.from("test-header-24-bytes!!!").toString("base64"),
				clientNonce: nonce,
				hasPassword: false,
				expiresIn: 3600,
				maxReads: 1,
				fileCount: 1,
				chunkCount: 1,
			}),
		});
		const { uploadId } = (await init.json()) as { uploadId: string };
		secrets.push(uploadId);
		const chunk = Buffer.from("chunk-ciphertext");
		const put = await app.request(`/api/v1/notes/upload/${uploadId}/chunks/0`, {
			method: "PUT",
			headers: { "X-Chunk-Hash": createHash("sha256").update(chunk).digest("hex") },
			body: new Uint8Array(chunk) as BodyInit,
		});
		expect(put.status).toBe(200);
		const complete = await app.request(`/api/v1/notes/upload/${uploadId}/complete`, {
			method: "POST",
		});
		const chunked = (await complete.json()) as { id: string; deleteToken: string };
		secrets.push(chunked.id, chunked.deleteToken);
		const stream = await app.request(`/api/v1/notes/${chunked.id}/stream`);
		expect(stream.status).toBe(200);
		await stream.arrayBuffer();
		// The burned stream purges its chunks once the body is out.
		await vi.waitFor(() =>
			expect(sqlite.prepare("SELECT COUNT(*) AS n FROM pending_deletions").get()).toEqual({ n: 0 }),
		);

		// Format 1 text notes: one burned by its only read, once a wrong link
		// proof was refused; one deleted by the wrong passwords it took.
		const linkProof = randomBytes(32).toString("base64");
		const passwordProof = randomBytes(32).toString("base64");
		const verifierOf = (proof: string) =>
			createHash("sha256").update(Buffer.from(proof, "base64")).digest("base64");
		async function createFormat1(password: boolean) {
			const envelope = encodeEnvelope({
				streamHeader: new Uint8Array(24),
				fileCount: 0,
				maxReads: 1,
				expiresIn: 3600,
				...(password
					? { argon2: { salt: new Uint8Array(16), iterations: 3, memoryKiB: 262_144 } }
					: {}),
			});
			const res = await app.request("/api/v1/notes", {
				method: "POST",
				headers: { ...auth, "Content-Type": "application/json" },
				body: JSON.stringify({
					envelope: Buffer.from(envelope).toString("base64"),
					linkVerifier: verifierOf(linkProof),
					...(password ? { passwordVerifier: verifierOf(passwordProof) } : {}),
					// One message: the smallest body, and its tag.
					encryptedData: randomBytes(BODY_FLOOR + SECRETSTREAM_ABYTES).toString("base64"),
				}),
			});
			expect(res.status).toBe(201);
			const note = (await res.json()) as { id: string; deleteToken: string };
			secrets.push(note.id, note.deleteToken);
			return note;
		}
		const readWith = (id: string, proofs: Record<string, string>) =>
			app.request(`/api/v1/notes/${id}/reads`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(proofs),
			});
		secrets.push(linkProof, passwordProof);

		const proven = await createFormat1(false);
		expect((await readWith(proven.id, { linkProof: passwordProof })).status).toBe(403);
		expect((await readWith(proven.id, { linkProof })).status).toBe(200);
		const guessed = await createFormat1(true);
		for (let attempt = 0; attempt < MAX_PASSWORD_ATTEMPTS; attempt += 1) {
			const res = await readWith(guessed.id, { linkProof, passwordProof: linkProof });
			expect(res.status).toBe(403);
		}

		const text = await (await scrape(app)).text();

		expect(sample(text, 'secret_notes_created_total{type="text"}')).toBe(4);
		expect(sample(text, 'secret_notes_created_total{type="file"}')).toBe(2);
		expect(sample(text, 'secret_notes_created_total{type="chunked"}')).toBe(1);
		expect(sample(text, 'secret_note_reads_total{type="text"}')).toBe(2);
		expect(sample(text, 'secret_note_reads_total{type="file"}')).toBe(2);
		expect(sample(text, 'secret_note_reads_total{type="chunked"}')).toBe(1);
		// The text notes by /:id and by their proofs, the file note by /raw, the
		// chunked one by /stream.
		expect(sample(text, "secret_notes_burned_total")).toBe(4);
		expect(sample(text, 'secret_read_proofs_refused_total{proof="link"}')).toBe(1);
		expect(sample(text, 'secret_read_proofs_refused_total{proof="password"}')).toBe(
			MAX_PASSWORD_ATTEMPTS,
		);
		expect(sample(text, "secret_notes_attempts_exhausted_total")).toBe(1);
		expect(
			sample(
				text,
				'secret_http_requests_total{method="POST",route="/api/v1/notes/:id/reads",status="4xx"}',
			),
		).toBe(1 + MAX_PASSWORD_ATTEMPTS);
		expect(sample(text, "secret_notes_deleted_total")).toBe(1);
		expect(sample(text, 'secret_notes{type="text"}')).toBe(0);
		expect(sample(text, 'secret_notes{type="file"}')).toBe(1);
		expect(sample(text, 'secret_notes{type="chunked"}')).toBe(0);
		expect(sample(text, "secret_storage_used_bytes")).toBeGreaterThan(0);
		expect(
			sample(
				text,
				'secret_http_requests_total{method="GET",route="/api/v1/notes/:id",status="2xx"}',
			),
		).toBe(2);
		expect(
			sample(
				text,
				'secret_http_requests_total{method="PUT",route="/api/v1/notes/upload/:uploadId/chunks/:index",status="2xx"}',
			),
		).toBe(1);
		// Each write under its own route: a pattern registered for one method
		// (a read's) must not name another's request.
		for (const [method, route] of [
			["POST", "/api/v1/notes"],
			["POST", "/api/v1/notes/upload"],
			["POST", "/api/v1/notes/upload/init"],
			["POST", "/api/v1/notes/upload/:uploadId/complete"],
			["POST", "/api/v1/notes/:id/reads"],
			["DELETE", "/api/v1/notes/:id"],
		]) {
			expect(
				sample(
					text,
					`secret_http_requests_total{method="${method}",route="${route}",status="2xx"}`,
				),
				`${method} ${route}`,
			).toBeGreaterThan(0);
		}
		for (const secret of secrets) {
			expect(text).not.toContain(secret);
		}
		// Every route label is a registered pattern, never a path.
		const routes = [...text.matchAll(/route="([^"]*)"/g)].map((match) => match[1]);
		expect(routes.length).toBeGreaterThan(0);
		for (const route of routes) {
			expect(route).toMatch(/^\/[a-z0-9/:*.-]*$/i);
			expect(route).not.toMatch(/[A-Za-z0-9_-]{12}(\/|$)/);
		}
	});
});

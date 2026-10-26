import { verifyApiKeyBuffers } from "@largerio/secret-shared/auth";
import { sql } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import type { BuildInfo } from "./buildInfo.js";
import type { AppDatabase } from "./db/index.js";
import { type Logger, log } from "./logger.js";
import { matchedRoute } from "./middleware/requestContext.js";
import { createRegistry, EXPOSITION_CONTENT_TYPE } from "./prometheus.js";
import { getStorageUsedBytes } from "./quota.js";
import type { SweepOutcome } from "./reconcile.js";
// Not storage/index.js: it loads both backends, and the shared schemas with them.
import { describeStorageError } from "./storage/errors.js";
import type { StorageBackend } from "./storage/interface.js";

/** How a note is stored: inline in the database, as one file, or in chunks. */
export type NoteType = "text" | "file" | "chunked";

const NOTE_TYPES: readonly NoteType[] = ["text", "file", "chunked"];
const SWEEP_STATUSES: ReadonlyArray<SweepOutcome["status"]> = [
	"done",
	"trial",
	"skipped",
	"failed",
];

/** Anything else is `other`: a label value must come from a bounded set. */
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"]);

/** Prometheus' default buckets, 5 ms to 10 s. */
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/**
 * The instance's metrics, one registry per app. Aggregates only: counts by
 * route pattern, note type or outcome, never a note id, an address or a raw
 * path.
 */
export interface AppMetrics {
	recordRequest(request: {
		readonly method: string;
		/** The route pattern (`/api/v1/notes/:id`), never the path. */
		readonly route: string;
		readonly status: number;
		readonly seconds: number;
	}): void;
	noteCreated(type: NoteType): void;
	/** A read served; `burned` when it was the last one the note allowed. */
	noteRead(type: NoteType, burned: boolean): void;
	noteDeleted(): void;
	/** Expired notes the cleanup job deleted. */
	notesExpired(count: number): void;
	purgeSettled(result: "ok" | "error"): void;
	/** Purges the cleanup job gave up on (`drainPendingDeletions().abandoned`). */
	deletionsAbandoned(count: number): void;
	sweepFinished(outcome: SweepOutcome): void;
	/** The exposition text, with what the database holds read now. */
	render(): string;
}

interface DatabaseCounts {
	readonly textNotes: number;
	readonly fileNotes: number;
	readonly chunkedNotes: number;
	readonly uploads: number;
	readonly queued: number;
	readonly retrying: number;
}

export function createMetrics(deps: {
	readonly db: AppDatabase;
	readonly build: BuildInfo;
	/** STORAGE_QUOTA_BYTES; 0 means none, and no quota gauge. */
	readonly quotaBytes: number;
	readonly logger?: Logger;
	/** Milliseconds since the epoch; injectable for tests. */
	readonly now?: () => number;
}): AppMetrics {
	const { db, build, quotaBytes } = deps;
	const logger = deps.logger ?? log;
	const now = deps.now ?? Date.now;
	const registry = createRegistry();

	registry
		.gauge("secret_build_info", "Version and revision of this build. Always 1.", [
			"version",
			"revision",
		])
		.set({ version: build.version, revision: build.revision }, 1);
	registry
		.gauge(
			"secret_process_start_time_seconds",
			"When the API process started, in seconds since the Unix epoch.",
		)
		.set({}, performance.timeOrigin / 1000);
	const residentMemory = registry.gauge(
		"secret_process_resident_memory_bytes",
		"Resident memory of the API process.",
	);
	const heapUsed = registry.gauge(
		"secret_process_heap_used_bytes",
		"V8 heap used by the API process.",
	);

	const httpRequests = registry.counter(
		"secret_http_requests_total",
		"HTTP requests answered by the API, by method, route pattern and status class.",
		["method", "route", "status"],
	);
	const httpDuration = registry.histogram(
		"secret_http_request_duration_seconds",
		"Time the API took to answer, up to the response headers (a streamed body is not included).",
		["method", "route"],
		DURATION_BUCKETS,
	);

	const created = registry.counter(
		"secret_notes_created_total",
		"Notes created, by type: text (stored in the database), file, chunked (large upload).",
		["type"],
	);
	const reads = registry.counter("secret_note_reads_total", "Note reads served, by note type.", [
		"type",
	]);
	const burned = registry.counter(
		"secret_notes_burned_total",
		"Notes deleted by the read that reached their read limit.",
	);
	const deleted = registry.counter(
		"secret_notes_deleted_total",
		"Notes deleted with their delete token.",
	);
	const expired = registry.counter(
		"secret_notes_expired_total",
		"Expired notes deleted by the cleanup job.",
	);
	for (const type of NOTE_TYPES) {
		created.inc({ type }, 0);
		reads.inc({ type }, 0);
	}
	burned.inc({}, 0);
	deleted.inc({}, 0);
	expired.inc({}, 0);

	const notes = registry.gauge(
		"secret_notes",
		"Notes in the database, by type, including expired ones the cleanup job has yet to delete.",
		["type"],
	);
	const uploadSessions = registry.gauge(
		"secret_upload_sessions",
		"Chunked uploads in progress, or abandoned and not expired yet.",
	);
	const storageUsed = registry.gauge(
		"secret_storage_used_bytes",
		"Encrypted payload bytes counted against the quota: notes and uploads in progress.",
	);
	if (quotaBytes > 0) {
		registry
			.gauge("secret_storage_quota_bytes", "The storage quota, STORAGE_QUOTA_BYTES.")
			.set({}, quotaBytes);
	}

	const purges = registry.counter(
		"secret_storage_purges_total",
		"Deletions of a note's stored payload, by result.",
		["result"],
	);
	purges.inc({ result: "ok" }, 0);
	purges.inc({ result: "error" }, 0);
	const pending = registry.gauge(
		"secret_pending_deletions",
		"Purges owed, by state: queued, or retrying once a retry has failed.",
		["state"],
	);
	const abandoned = registry.counter(
		"secret_pending_deletions_abandoned_total",
		"Purges given up after their last retry. The storage sweep removes what they left.",
	);
	abandoned.inc({}, 0);

	const sweepTime = registry.gauge(
		"secret_storage_sweep_last_run_timestamp_seconds",
		"When the last storage sweep ended, in seconds since the Unix epoch.",
	);
	const sweepStatus = registry.gauge(
		"secret_storage_sweep_last_status",
		"How the last storage sweep ended: 1 for its status, 0 for the others.",
		["status"],
	);
	const sweepOrphans = registry.gauge(
		"secret_storage_sweep_last_orphans",
		"Stored payloads no note points to, found by the last sweep that ran: purged, or only counted on trial.",
	);

	const databaseGauges = [notes, uploadSessions, storageUsed, pending];

	function readDatabase(): void {
		let counts: DatabaseCounts;
		let usedBytes: number;
		try {
			// A scalar SELECT always yields exactly one row.
			counts = db.get<DatabaseCounts>(sql`
				SELECT
					(SELECT COUNT(*) FROM notes
					  WHERE file_path IS NULL AND COALESCE(chunk_count, 0) = 0) AS textNotes,
					(SELECT COUNT(*) FROM notes WHERE file_path IS NOT NULL) AS fileNotes,
					(SELECT COUNT(*) FROM notes WHERE chunk_count > 0) AS chunkedNotes,
					(SELECT COUNT(*) FROM uploads) AS uploads,
					(SELECT COUNT(*) FROM pending_deletions WHERE attempts = 0) AS queued,
					(SELECT COUNT(*) FROM pending_deletions WHERE attempts > 0) AS retrying
			`) as DatabaseCounts;
			usedBytes = getStorageUsedBytes(db);
		} catch (err) {
			// Absent rather than stale: a scrape without them says the read failed.
			for (const gauge of databaseGauges) {
				gauge.reset();
			}
			logger.error("metrics could not read the database", {
				detail: describeStorageError(err),
			});
			return;
		}
		notes.set({ type: "text" }, counts.textNotes);
		notes.set({ type: "file" }, counts.fileNotes);
		notes.set({ type: "chunked" }, counts.chunkedNotes);
		uploadSessions.set({}, counts.uploads);
		storageUsed.set({}, usedBytes);
		pending.set({ state: "queued" }, counts.queued);
		pending.set({ state: "retrying" }, counts.retrying);
	}

	return {
		recordRequest({ method, route, status, seconds }) {
			const knownMethod = METHODS.has(method) ? method : "other";
			httpRequests.inc({
				method: knownMethod,
				route,
				status: `${String(Math.floor(status / 100))}xx`,
			});
			httpDuration.observe({ method: knownMethod, route }, seconds);
		},
		noteCreated(type) {
			created.inc({ type });
		},
		noteRead(type, wasBurned) {
			reads.inc({ type });
			if (wasBurned) {
				burned.inc({});
			}
		},
		noteDeleted() {
			deleted.inc({});
		},
		notesExpired(count) {
			expired.inc({}, count);
		},
		purgeSettled(result) {
			purges.inc({ result });
		},
		deletionsAbandoned(count) {
			abandoned.inc({}, count);
		},
		sweepFinished(outcome) {
			sweepTime.set({}, now() / 1000);
			for (const status of SWEEP_STATUSES) {
				sweepStatus.set({ status }, status === outcome.status ? 1 : 0);
			}
			if (outcome.status === "done") {
				sweepOrphans.set({}, outcome.purged + outcome.failed);
			} else if (outcome.status === "trial") {
				sweepOrphans.set({}, outcome.orphans);
			}
		},
		render() {
			const memory = process.memoryUsage();
			residentMemory.set({}, memory.rss);
			heapUsed.set({}, memory.heapUsed);
			readDatabase();
			return registry.render();
		},
	};
}

/** Count every request, by route pattern, once it is answered. */
export function createRequestMetrics(metrics: AppMetrics): MiddlewareHandler {
	return async (c, next) => {
		const start = performance.now();
		await next();
		metrics.recordRequest({
			method: c.req.method,
			route: matchedRoute(c),
			status: c.res.status,
			seconds: (performance.now() - start) / 1000,
		});
	};
}

/**
 * `GET /api/metrics`, registered only when METRICS_TOKEN is set. The token is
 * a bearer token, compared in constant time like the API keys.
 */
export function createMetricsHandler(metrics: AppMetrics, token: string): (c: Context) => Response {
	const known = [Buffer.from(token)];
	return (c) => {
		const candidate = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
		if (!verifyApiKeyBuffers(candidate, known)) {
			c.header("WWW-Authenticate", 'Bearer realm="metrics"');
			return c.json({ error: "Unauthorized" }, 401);
		}
		c.header("Cache-Control", "no-store");
		c.header("Content-Type", EXPOSITION_CONTENT_TYPE);
		return c.body(metrics.render());
	};
}

/**
 * The storage, with every purge counted by result. The routes, the cleanup
 * job's retries and the storage sweep all purge through it, so the count
 * misses none. A method the backend leaves out stays out: a missing probe
 * means healthy.
 */
export function countPurges(storage: StorageBackend, metrics: AppMetrics): StorageBackend {
	const { probe, close } = storage;
	return {
		save: (noteId, data) => storage.save(noteId, data),
		read: (key) => storage.read(key),
		saveChunk: (noteId, index, data) => storage.saveChunk(noteId, index, data),
		readChunk: (noteId, index) => storage.readChunk(noteId, index),
		async purge(noteId) {
			try {
				await storage.purge(noteId);
			} catch (err) {
				metrics.purgeSettled("error");
				throw err;
			}
			metrics.purgeSettled("ok");
		},
		list: () => storage.list(),
		claim: (instanceId) => storage.claim(instanceId),
		listClaims: () => storage.listClaims(),
		...(probe ? { probe: () => probe.call(storage) } : {}),
		...(close ? { close: () => close.call(storage) } : {}),
	};
}

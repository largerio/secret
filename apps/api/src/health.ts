import { sql } from "drizzle-orm";
import type { AppDatabase } from "./db/index.js";
import type { StorageBackend } from "./storage/index.js";

export interface HealthReport {
	readonly status: "ok" | "degraded";
	readonly checks: {
		readonly database: "ok" | "error";
		readonly storage: "ok" | "error";
	};
}

/** Health probes are cached this long so the endpoint can't be used to hammer S3. */
const CACHE_TTL_MS = 10_000;

/**
 * Build a health probe that actually touches the database and the storage
 * backend. An endpoint that returns a hardcoded `{status:"ok"}` reports healthy
 * while every note read fails with a 500 (expired S3 credentials, full or
 * read-only volume, locked database) — so the orchestrator keeps routing
 * traffic to a broken instance and the failure is only found by users.
 */
export function createHealthCheck(
	db: AppDatabase,
	storage: StorageBackend,
	options?: { ttlMs?: number; now?: () => number },
): () => Promise<HealthReport> {
	const ttlMs = options?.ttlMs ?? CACHE_TTL_MS;
	const now = options?.now ?? Date.now;

	let cached: { at: number; report: HealthReport } | undefined;
	let inFlight: Promise<HealthReport> | undefined;

	async function probe(): Promise<HealthReport> {
		let database: "ok" | "error" = "ok";
		let storageStatus: "ok" | "error" = "ok";

		try {
			db.get(sql`SELECT 1`);
		} catch (err) {
			database = "error";
			console.error("[health] database probe failed:", Error.isError(err) ? err.message : err);
		}

		try {
			await storage.probe?.();
		} catch (err) {
			storageStatus = "error";
			console.error("[health] storage probe failed:", Error.isError(err) ? err.message : err);
		}

		const ok = database === "ok" && storageStatus === "ok";
		return { status: ok ? "ok" : "degraded", checks: { database, storage: storageStatus } };
	}

	return async function check(): Promise<HealthReport> {
		const at = now();
		if (cached && at - cached.at < ttlMs) return cached.report;
		// Collapse concurrent probes so a burst of health checks issues one round.
		inFlight ??= probe().finally(() => {
			inFlight = undefined;
		});
		const report = await inFlight;
		cached = { at, report };
		return report;
	};
}

import { type CreatedApp, createApp } from "./app.js";
import type { BuildInfo } from "./buildInfo.js";
import { startCleanupJob } from "./cleanup.js";
import type { AppConfig } from "./config.js";
import type { AppDatabase } from "./db/index.js";
import { countPurges, createMetrics } from "./metrics.js";
import { claimStorage, startReconcileJob } from "./reconcile.js";
import type { StorageBackend } from "./storage/interface.js";

export interface Instance extends CreatedApp {
	/** The storage the app and the jobs share, its purges counted. */
	readonly storage: StorageBackend;
	/** Stop the cleanup job and the storage sweep. */
	readonly stopJobs: () => void;
}

/**
 * The app and what runs beside it, the cleanup job and the storage sweep, all
 * counted in one metrics registry: the one /api/metrics serves. A job or a
 * storage given a registry of its own would count where nobody scrapes. This
 * schedules the jobs and claims the storage; the caller starts the server.
 */
export function startInstance(deps: {
	readonly db: AppDatabase;
	readonly serverKey: Buffer;
	readonly config: AppConfig;
	readonly build: BuildInfo;
	/** The backend config.storage describes (createStorageBackend). */
	readonly backend: StorageBackend;
}): Instance {
	const { db, serverKey, config, build } = deps;
	const metrics = createMetrics({ db, build, quotaBytes: config.storageQuotaBytes });
	const storage = countPurges(deps.backend, metrics);
	const created = createApp({ db, serverKey, storage, config, metrics, build });

	const cleanupTimer = startCleanupJob(db, storage, config.cleanupIntervalMs, metrics);
	// Claimed whether this instance sweeps or not, so a sweeping one sharing the
	// storage by mistake stops instead of taking these notes for orphans.
	void claimStorage(db, storage);
	const reconcileJob = config.storageReconcile
		? startReconcileJob(db, storage, (outcome) => metrics.sweepFinished(outcome))
		: undefined;

	return {
		...created,
		storage,
		stopJobs() {
			clearInterval(cleanupTimer);
			reconcileJob?.stop();
		},
	};
}

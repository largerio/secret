import type { Hono } from "hono";
import { type AppEnv, createApp } from "../app.js";
import { UNKNOWN_BUILD } from "../buildInfo.js";
import { type AppConfig, parseConfig } from "../config.js";
import type { AppDatabase } from "../db/index.js";
import { createLogger } from "../logger.js";
import { createMetrics } from "../metrics.js";
import { createNotesService, type NotesService } from "../notes/service.js";
import type { StorageBackend } from "../storage/index.js";

export interface TestApp {
	readonly app: Hono<AppEnv>;
	/** Clears the rate limiters' sweep timers. */
	readonly stop: () => void;
}

/**
 * The application as the server assembles it (middleware, body and rate
 * limits, auth, error handler) over the given database and storage,
 * configured from `env` as an operator would. Every test request comes from
 * the same address, so the per-IP bounds are raised a hundredfold. Request
 * logs stay quiet; the routes' own log lines still reach the console, where
 * tests watch them.
 */
export function createTestApp(options: {
	readonly db: AppDatabase;
	readonly serverKey: Buffer;
	readonly storage: StorageBackend;
	readonly env?: Record<string, string>;
}): TestApp {
	const config = testConfig(options.serverKey, { RATE_LIMIT_MULTIPLIER: "100", ...options.env });
	const created = createApp({
		db: options.db,
		serverKey: options.serverKey,
		storage: options.storage,
		config,
		logger: createLogger({ write: () => {} }),
	});
	return {
		app: created.app,
		stop: () => {
			for (const limiter of created.rateLimiters) limiter.cleanup();
		},
	};
}

/** The notes service alone, configured from `env` as the app would be. */
export function createTestNotesService(options: {
	readonly db: AppDatabase;
	readonly serverKey: Buffer;
	readonly storage: StorageBackend;
	readonly env?: Record<string, string>;
}): NotesService {
	const config = testConfig(options.serverKey, options.env);
	return createNotesService({
		db: options.db,
		serverKey: options.serverKey,
		storage: options.storage,
		metrics: createMetrics({
			db: options.db,
			build: UNKNOWN_BUILD,
			quotaBytes: config.storageQuotaBytes,
			logger: createLogger({ write: () => {} }),
		}),
		limits: config,
	});
}

function testConfig(serverKey: Buffer, env: Record<string, string> = {}): AppConfig {
	return parseConfig({
		SERVER_ENCRYPTION_KEY: serverKey.toString("base64"),
		...env,
	} as NodeJS.ProcessEnv);
}

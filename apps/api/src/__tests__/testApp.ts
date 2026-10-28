import type { Hono } from "hono";
import { type AppEnv, createApp } from "../app.js";
import { parseConfig } from "../config.js";
import type { AppDatabase } from "../db/index.js";
import { createLogger } from "../logger.js";
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
	const config = parseConfig({
		SERVER_ENCRYPTION_KEY: options.serverKey.toString("base64"),
		RATE_LIMIT_MULTIPLIER: "100",
		...options.env,
	} as NodeJS.ProcessEnv);
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

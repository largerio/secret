import { serve } from "@hono/node-server";
import { parseServerKey } from "@largerio/secret-crypto/server";
import { createApp } from "./app.js";
import { startCleanupJob } from "./cleanup.js";
import { ConfigError, describeRateLimitScope, parseConfig } from "./config.js";
import { createDatabase } from "./db/index.js";
import { DatabaseVersionError, MigrationError } from "./db/migrations.js";
import { assertServerKeyMatches, ServerKeyMismatchError } from "./keyGuard.js";
import { log } from "./logger.js";
import { createStorageBackend } from "./storage/index.js";

function fail(message: string, hint?: string): never {
	log.error("startup failed", { error: message, ...(hint ? { hint } : {}) });
	process.exit(1);
}

let config: ReturnType<typeof parseConfig>;
try {
	config = parseConfig(process.env);
} catch (err) {
	if (err instanceof ConfigError) {
		fail(err.message, err.hint);
	}
	throw err;
}

const serverKey = parseServerKey(config.serverKey);

let database: ReturnType<typeof createDatabase>;
try {
	database = createDatabase(config.databasePath);
} catch (err) {
	if (err instanceof DatabaseVersionError || err instanceof MigrationError) {
		fail(err.message, err.hint);
	}
	throw err;
}
const { db, sqlite } = database;

try {
	assertServerKeyMatches(db, serverKey, { allowChange: config.allowServerKeyChange });
} catch (err) {
	if (err instanceof ServerKeyMismatchError) {
		sqlite.close();
		fail(err.message, err.hint);
	}
	throw err;
}

const storage = createStorageBackend(config.storage);

const { app, rateLimiters } = createApp({ db, serverKey, storage, config });

const cleanupTimer = startCleanupJob(db, storage, config.cleanupIntervalMs);

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port });

// An unhandled rejection would otherwise terminate the process with no usable
// log line; surface it, then let the normal shutdown path run.
process.on("unhandledRejection", (reason) => {
	log.error("unhandled promise rejection", { reason });
	shutdown(1);
});
process.on("uncaughtException", (err) => {
	log.error("uncaught exception", { error: err });
	shutdown(1);
});

let shuttingDown = false;

function shutdown(exitCode = 0): void {
	// SIGINT followed by SIGTERM (or a signal during a fatal handler) would
	// otherwise close the server twice.
	if (shuttingDown) return;
	shuttingDown = true;

	log.info("graceful shutdown initiated");
	clearInterval(cleanupTimer);
	for (const limiter of rateLimiters) {
		limiter.cleanup();
	}
	// Hard fallback: never let a hung close() keep the process alive forever.
	// Kept under Docker's default 10s stop grace period so the WAL checkpoint in
	// sqlite.close() still runs before SIGKILL; the compose file raises that
	// grace period to 30s to leave room for in-flight requests to drain.
	const forceExit = setTimeout(() => {
		log.error("shutdown timed out waiting for connections to close");
		sqlite.close();
		process.exit(exitCode || 1);
	}, 8_000);
	forceExit.unref();

	server.close(async () => {
		try {
			await storage.close?.();
		} catch (err) {
			log.error("storage close failed during shutdown", {
				detail: Error.isError(err) ? err.message : err,
			});
		}
		sqlite.close();
		process.exit(exitCode);
	});
}

process.on("SIGTERM", () => shutdown());
process.on("SIGINT", () => shutdown());

const rateLimitWarning = describeRateLimitScope(config);
if (rateLimitWarning) {
	log.warn(rateLimitWarning);
}

log.info("secret api listening", {
	host: config.host,
	port: config.port,
	storage: config.storageBackend,
});

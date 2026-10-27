import { serve } from "@hono/node-server";
// Extends Zod with `.openapi()` before `@largerio/secret-shared` builds its
// schemas, which config.js loads first and the routes extend.
import "@hono/zod-openapi";
import { parseServerKey } from "@largerio/secret-crypto/server";
import { readBuildInfo } from "./buildInfo.js";
import { ConfigError, describeRateLimitScope, parseConfig } from "./config.js";
import { createDatabase } from "./db/index.js";
import { DatabaseVersionError, MigrationError } from "./db/migrations.js";
import { startInstance } from "./instance.js";
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

const build = readBuildInfo(process.env);
const { app, rateLimiters, drain, storage, stopJobs } = startInstance({
	db,
	serverKey,
	config,
	build,
	backend: createStorageBackend(config.storage),
});

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
	// First, so a load balancer polling readiness stops sending requests while
	// the ones in flight finish.
	drain();
	stopJobs();
	for (const limiter of rateLimiters) {
		limiter.cleanup();
	}
	// Hard fallback: never let a hung close() keep the process alive forever.
	// Docker sends SIGKILL 10 s after SIGTERM unless told otherwise
	// (`stop_grace_period`, which docker-compose.yml leaves at that default, or
	// `--stop-timeout`), and entrypoint.sh relays the signal within a second.
	// So in-flight requests get SHUTDOWN_TIMEOUT, 8 s by default, as in the web
	// server in front: then they are cut and sqlite.close() checkpoints the WAL
	// before the SIGKILL. A longer drain needs both raised, the timeout a couple
	// of seconds under the grace period.
	const forceExit = setTimeout(() => {
		log.error("shutdown timed out waiting for connections to close");
		sqlite.close();
		process.exit(exitCode || 1);
	}, config.shutdownTimeoutMs);
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
	version: build.version,
	revision: build.revision,
	metrics: config.metricsToken !== "",
});

import { serve } from "@hono/node-server";
import { parseServerKey } from "@largerio/secret-crypto/server";
import { createApp } from "./app.js";
import { startCleanupJob } from "./cleanup.js";
import { ConfigError, describeRateLimitScope, parseConfig } from "./config.js";
import { createDatabase } from "./db/index.js";
import { assertServerKeyMatches, ServerKeyMismatchError } from "./keyGuard.js";
import { createStorageBackend } from "./storage/index.js";

function fail(message: string, hint?: string): never {
	console.error(`ERROR: ${message}`);
	if (hint) {
		console.error(hint);
	}
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
const { db, sqlite } = createDatabase(config.databasePath);

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
	console.error("[fatal] Unhandled promise rejection:", reason);
	shutdown(1);
});
process.on("uncaughtException", (err) => {
	console.error("[fatal] Uncaught exception:", err);
	shutdown(1);
});

let shuttingDown = false;

function shutdown(exitCode = 0): void {
	// SIGINT followed by SIGTERM (or a signal during a fatal handler) would
	// otherwise close the server twice.
	if (shuttingDown) return;
	shuttingDown = true;

	console.log("[shutdown] Graceful shutdown initiated");
	clearInterval(cleanupTimer);
	for (const limiter of rateLimiters) {
		limiter.cleanup();
	}
	// Hard fallback: never let a hung close() keep the process alive forever.
	// Kept under Docker's default 10s stop grace period so the WAL checkpoint in
	// sqlite.close() still runs before SIGKILL; the compose file raises that
	// grace period to 30s to leave room for in-flight requests to drain.
	const forceExit = setTimeout(() => {
		console.error("[shutdown] Timed out waiting for connections to close");
		sqlite.close();
		process.exit(exitCode || 1);
	}, 8_000);
	forceExit.unref();

	server.close(async () => {
		try {
			await storage.close?.();
		} catch (err) {
			console.error("[shutdown] storage close failed:", Error.isError(err) ? err.message : err);
		}
		sqlite.close();
		process.exit(exitCode);
	});
}

process.on("SIGTERM", () => shutdown());
process.on("SIGINT", () => shutdown());

const rateLimitWarning = describeRateLimitScope(config);
if (rateLimitWarning) {
	console.warn(rateLimitWarning);
}

console.log(
	`Secret API listening on ${config.host}:${String(config.port)} [storage=${config.storageBackend}]`,
);

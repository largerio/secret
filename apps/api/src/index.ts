import { serve } from "@hono/node-server";
import { parseServerKey } from "@secret/crypto";
import { createApp } from "./app.js";
import { startCleanupJob } from "./cleanup.js";
import { ConfigError, parseConfig } from "./config.js";
import { createDatabase } from "./db/index.js";
import { createStorageBackend } from "./storage/index.js";

let config: ReturnType<typeof parseConfig>;
try {
	config = parseConfig(process.env);
} catch (err) {
	if (err instanceof ConfigError) {
		console.error(`ERROR: ${err.message}`);
		if (err.hint) {
			console.error(err.hint);
		}
		process.exit(1);
	}
	throw err;
}

const serverKey = parseServerKey(config.serverKey);
const { db, sqlite } = createDatabase(config.databasePath);
const storage = createStorageBackend(config.storage);

const { app, rateLimiters } = createApp({ db, serverKey, storage, config });

const cleanupTimer = startCleanupJob(db, storage, config.cleanupIntervalMs);

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port });

function shutdown(): void {
	console.log("[shutdown] Graceful shutdown initiated");
	clearInterval(cleanupTimer);
	for (const limiter of rateLimiters) {
		limiter.cleanup();
	}
	server.close(() => {
		sqlite.close();
		process.exit(0);
	});
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

console.log(
	`Secret API listening on ${config.host}:${String(config.port)} [storage=${config.storageBackend}]`,
);

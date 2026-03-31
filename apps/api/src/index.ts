import { serve } from "@hono/node-server";
import { parseServerKey } from "@secret/crypto";
import { CLEANUP_INTERVAL_MS, MAX_FILE_SIZE, MAX_FILES_PER_NOTE } from "@secret/shared";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { startCleanupJob } from "./cleanup.js";
import type { AppDatabase } from "./db/index.js";
import { createDatabase } from "./db/index.js";
import { createRateLimit } from "./middleware/rateLimit.js";
import { createCors, createSecurityHeaders } from "./middleware/security.js";
import { createNotesRoutes } from "./routes/notes.js";
import type { StorageBackend, StorageType } from "./storage/index.js";
import { createStorageBackend } from "./storage/index.js";

const env = process.env;
const PORT = Number(env["PORT"] ?? "3001");
const HOST = env["HOST"] ?? "0.0.0.0";
const DATABASE_PATH = env["DATABASE_PATH"] ?? "./data/secret.db";
const FILES_PATH = env["FILES_PATH"] ?? "./data/files";
const SERVER_KEY_ENV = env["SERVER_ENCRYPTION_KEY"];
const APP_URL = env["APP_URL"] ?? `http://localhost:${String(PORT)}`;
const CLEANUP_MS = Number(env["CLEANUP_INTERVAL_MS"] ?? String(CLEANUP_INTERVAL_MS));

const APP_NAME = env["APP_NAME"] ?? "Secret";
const APP_DESCRIPTION = env["APP_DESCRIPTION"] ?? "Zero-knowledge encrypted sharing";
const APP_PRIMARY_COLOR = env["APP_PRIMARY_COLOR"] ?? "#6366f1";
const APP_FOOTER_TEXT = env["APP_FOOTER_TEXT"] ?? "";
const APP_OG_IMAGE_URL = env["APP_OG_IMAGE_URL"] ?? "";

const STORAGE_BACKEND = (env["STORAGE_BACKEND"] ?? "local") as StorageType;
const S3_BUCKET = env["S3_BUCKET"] ?? "";
const S3_REGION = env["S3_REGION"] ?? "us-east-1";
const S3_ENDPOINT = env["S3_ENDPOINT"];
const S3_ACCESS_KEY_ID = env["S3_ACCESS_KEY_ID"] ?? "";
const S3_SECRET_ACCESS_KEY = env["S3_SECRET_ACCESS_KEY"] ?? "";
const S3_FORCE_PATH_STYLE = env["S3_FORCE_PATH_STYLE"] === "true";

const CONFIGURED_MAX_FILE_SIZE = Number(env["MAX_FILE_SIZE"] ?? String(MAX_FILE_SIZE));
const CONFIGURED_MAX_FILES = Number(env["MAX_FILES_PER_NOTE"] ?? String(MAX_FILES_PER_NOTE));

if (!SERVER_KEY_ENV) {
	console.error("ERROR: SERVER_ENCRYPTION_KEY is required.");
	console.error(
		"Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
	);
	process.exit(1);
}

if (Number.isNaN(PORT) || PORT <= 0) {
	console.error("ERROR: PORT must be a positive number");
	process.exit(1);
}

if (Number.isNaN(CLEANUP_MS) || CLEANUP_MS <= 0) {
	console.error("ERROR: CLEANUP_INTERVAL_MS must be a positive number");
	process.exit(1);
}

if (STORAGE_BACKEND !== "local" && STORAGE_BACKEND !== "s3") {
	console.error("ERROR: STORAGE_BACKEND must be 'local' or 's3'");
	process.exit(1);
}

const serverKey = parseServerKey(SERVER_KEY_ENV);
const { db, sqlite } = createDatabase(DATABASE_PATH);

const storage = createStorageBackend(
	STORAGE_BACKEND === "s3"
		? {
				type: "s3",
				s3: {
					bucket: S3_BUCKET,
					region: S3_REGION,
					...(S3_ENDPOINT ? { endpoint: S3_ENDPOINT } : {}),
					accessKeyId: S3_ACCESS_KEY_ID,
					secretAccessKey: S3_SECRET_ACCESS_KEY,
					forcePathStyle: S3_FORCE_PATH_STYLE,
				},
			}
		: { type: "local", localPath: FILES_PATH },
);

interface AppEnv {
	Variables: {
		db: AppDatabase;
		serverKey: Buffer;
		storage: StorageBackend;
	};
}

const app = new Hono<AppEnv>();

app.onError((err, c) => {
	console.error("[error]", err.message);
	return c.json({ error: "Internal server error" }, 500);
});

app.notFound((c) => c.json({ error: "Not found" }, 404));

app.use("*", createSecurityHeaders());
app.use("*", createCors([APP_URL]));

const maxBodySize = CONFIGURED_MAX_FILE_SIZE * CONFIGURED_MAX_FILES + 1024 * 1024;
app.use(
	"/api/notes",
	bodyLimit({ maxSize: maxBodySize, onError: (c) => c.json({ error: "Payload too large" }, 413) }),
);
app.use(
	"/api/notes/upload",
	bodyLimit({ maxSize: maxBodySize, onError: (c) => c.json({ error: "Payload too large" }, 413) }),
);

const notesRateLimit = createRateLimit({ windowMs: 60_000, max: 100 });
const notesDetailRateLimit = createRateLimit({ windowMs: 60_000, max: 200 });
app.use("/api/notes", notesRateLimit.middleware);
app.use("/api/notes/*", notesDetailRateLimit.middleware);

app.use("*", async (c, next) => {
	c.set("db", db);
	c.set("serverKey", serverKey);
	c.set("storage", storage);
	await next();
});

app.get("/api/health", (c) => c.json({ status: "ok" }));
app.get("/api/config", (c) =>
	c.json({
		appName: APP_NAME,
		appDescription: APP_DESCRIPTION,
		primaryColor: APP_PRIMARY_COLOR,
		footerText: APP_FOOTER_TEXT,
		ogImageUrl: APP_OG_IMAGE_URL,
		maxFileSize: CONFIGURED_MAX_FILE_SIZE,
		maxFilesPerNote: CONFIGURED_MAX_FILES,
		storageType: STORAGE_BACKEND,
	}),
);
app.route("/api/notes", createNotesRoutes());

const cleanupTimer = startCleanupJob(db, storage, CLEANUP_MS);

const server = serve({ fetch: app.fetch, hostname: HOST, port: PORT });

function shutdown(): void {
	console.log("[shutdown] Graceful shutdown initiated");
	clearInterval(cleanupTimer);
	notesRateLimit.cleanup();
	notesDetailRateLimit.cleanup();
	server.close(() => {
		sqlite.close();
		process.exit(0);
	});
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

console.log(`Secret API listening on ${HOST}:${String(PORT)} [storage=${STORAGE_BACKEND}]`);

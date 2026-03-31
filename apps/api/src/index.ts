import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { serve } from "@hono/node-server";
import { parseServerKey } from "@secret/crypto";
import { CLEANUP_INTERVAL_MS, MAX_FILE_SIZE, MAX_FILES_PER_NOTE } from "@secret/shared";
import { createDatabase } from "./db/index.js";
import { createNotesRoutes } from "./routes/notes.js";
import { createSecurityHeaders, createCors } from "./middleware/security.js";
import { createRateLimit } from "./middleware/rateLimit.js";
import { startCleanupJob } from "./cleanup.js";
import { ensureFilesDir } from "./storage/files.js";

const PORT = Number(process.env["PORT"] ?? "3001");
const HOST = process.env["HOST"] ?? "0.0.0.0";
const DATABASE_PATH = process.env["DATABASE_PATH"] ?? "./data/secret.db";
const FILES_PATH = process.env["FILES_PATH"] ?? "./data/files";
const SERVER_KEY_ENV = process.env["SERVER_ENCRYPTION_KEY"];
const APP_URL = process.env["APP_URL"] ?? `http://localhost:${String(PORT)}`;
const CLEANUP_MS = Number(process.env["CLEANUP_INTERVAL_MS"] ?? String(CLEANUP_INTERVAL_MS));

const APP_NAME = process.env["APP_NAME"] ?? "Secret";
const APP_DESCRIPTION = process.env["APP_DESCRIPTION"] ?? "Zero-knowledge encrypted sharing";
const APP_PRIMARY_COLOR = process.env["APP_PRIMARY_COLOR"] ?? "#6366f1";
const APP_FOOTER_TEXT = process.env["APP_FOOTER_TEXT"] ?? "";
const APP_OG_IMAGE_URL = process.env["APP_OG_IMAGE_URL"] ?? "";

if (!SERVER_KEY_ENV) {
	console.error("ERROR: SERVER_ENCRYPTION_KEY is required.");
	console.error('Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"');
	process.exit(1);
}

const serverKey = parseServerKey(SERVER_KEY_ENV);
const { db, sqlite } = createDatabase(DATABASE_PATH);
ensureFilesDir(FILES_PATH);

const app = new Hono();

app.use("*", createSecurityHeaders());
app.use("*", createCors([APP_URL]));

const maxBodySize = MAX_FILE_SIZE * MAX_FILES_PER_NOTE + 1024 * 1024;
app.use("/api/notes", bodyLimit({ maxSize: maxBodySize, onError: (c) => c.json({ error: "Payload too large" }, 413) }));
app.use("/api/notes", createRateLimit({ windowMs: 60_000, max: 100 }));
app.use("/api/notes/*", createRateLimit({ windowMs: 60_000, max: 200 }));

app.use("*", async (c, next) => {
	c.set("db", db);
	c.set("serverKey", serverKey);
	c.set("filesPath", FILES_PATH);
	await next();
});

app.get("/api/health", (c) => c.json({ status: "ok" }));
app.get("/api/config", (c) => c.json({
	appName: APP_NAME,
	appDescription: APP_DESCRIPTION,
	primaryColor: APP_PRIMARY_COLOR,
	footerText: APP_FOOTER_TEXT,
	ogImageUrl: APP_OG_IMAGE_URL,
}));
app.route("/api/notes", createNotesRoutes());

const cleanupTimer = startCleanupJob(db, CLEANUP_MS);

function shutdown() {
	console.log("[shutdown] Graceful shutdown initiated");
	clearInterval(cleanupTimer);
	sqlite.close();
	process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

console.log(`Secret API listening on ${HOST}:${String(PORT)}`);
serve({ fetch: app.fetch, hostname: HOST, port: PORT });

import { serve } from "@hono/node-server";
import { OpenAPIHono } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import { parseServerKey } from "@secret/crypto";
import {
	CLEANUP_INTERVAL_MS,
	DEFAULT_CHUNK_SIZE,
	DEFAULT_MAX_CHUNKED_SIZE,
	MAX_FILE_SIZE,
	MAX_FILES_PER_NOTE,
} from "@secret/shared";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { compress } from "hono/compress";
import { startCleanupJob } from "./cleanup.js";
import type { AppDatabase } from "./db/index.js";
import { createDatabase } from "./db/index.js";
import { createWriteAuth } from "./middleware/auth.js";
import { createErrorHandler } from "./middleware/errorHandler.js";
import { buildTrustedBlockList, createRateLimit } from "./middleware/rateLimit.js";
import {
	createCors,
	createDocsSecurityHeaders,
	createSecurityHeaders,
} from "./middleware/security.js";
import { createCapRoutes } from "./routes/cap.js";
import { createNotesRoutes } from "./routes/notes/index.js";
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

const API_KEYS = Object.entries(env)
	.filter(([key]) => /^API_KEY(_\d+)?$/.test(key))
	.map(([, value]) => value?.trim())
	.filter((v): v is string => Boolean(v));

const STORAGE_BACKEND = (env["STORAGE_BACKEND"] ?? "local") as StorageType;
const S3_BUCKET = env["S3_BUCKET"] ?? "";
const S3_REGION = env["S3_REGION"] ?? "us-east-1";
const S3_ENDPOINT = env["S3_ENDPOINT"];
const S3_ACCESS_KEY_ID = env["S3_ACCESS_KEY_ID"] ?? "";
const S3_SECRET_ACCESS_KEY = env["S3_SECRET_ACCESS_KEY"] ?? "";
const S3_FORCE_PATH_STYLE = env["S3_FORCE_PATH_STYLE"] === "true";

const CONFIGURED_MAX_FILE_SIZE = Number(env["MAX_FILE_SIZE"] ?? String(MAX_FILE_SIZE));
const CONFIGURED_MAX_FILES = Number(env["MAX_FILES_PER_NOTE"] ?? String(MAX_FILES_PER_NOTE));
const CHUNK_SIZE = Number(env["CHUNK_SIZE"] ?? String(DEFAULT_CHUNK_SIZE));
const MAX_CHUNKED_FILE_SIZE = Number(
	env["MAX_CHUNKED_FILE_SIZE"] ?? String(DEFAULT_MAX_CHUNKED_SIZE),
);
const TRUSTED_PROXIES = (env["TRUSTED_PROXIES"] ?? "")
	.split(",")
	.map((v) => v.trim())
	.filter((v) => v.length > 0);

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

if (Number.isNaN(CHUNK_SIZE) || CHUNK_SIZE <= 0) {
	console.error("ERROR: CHUNK_SIZE must be a positive number");
	process.exit(1);
}

if (Number.isNaN(MAX_CHUNKED_FILE_SIZE) || MAX_CHUNKED_FILE_SIZE <= 0) {
	console.error("ERROR: MAX_CHUNKED_FILE_SIZE must be a positive number");
	process.exit(1);
}

if (CHUNK_SIZE > MAX_CHUNKED_FILE_SIZE) {
	console.error("ERROR: CHUNK_SIZE must be less than or equal to MAX_CHUNKED_FILE_SIZE");
	process.exit(1);
}

try {
	buildTrustedBlockList(TRUSTED_PROXIES);
} catch (err) {
	console.error(
		`ERROR: TRUSTED_PROXIES contains an invalid entry: ${Error.isError(err) ? err.message : String(err)}`,
	);
	process.exit(1);
}

if (STORAGE_BACKEND === "s3" && (!S3_BUCKET || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY)) {
	console.error(
		"ERROR: S3_BUCKET, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY are required when STORAGE_BACKEND=s3",
	);
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
		chunkSize: number;
		maxChunkedFileSize: number;
	};
}

const app = new Hono<AppEnv>();

app.onError(createErrorHandler({ debug: env["DEBUG"] === "1" || env["DEBUG"] === "true" }));

app.notFound((c) => c.json({ error: "Not found" }, 404));

app.use("/api/v1/docs", createDocsSecurityHeaders());
app.use("*", createSecurityHeaders({ skipPaths: ["/api/v1/docs"] }));
app.use("*", createCors([APP_URL]));
app.use("*", compress());

const maxBodySize = CONFIGURED_MAX_FILE_SIZE * CONFIGURED_MAX_FILES + 1024 * 1024;
app.use(
	"/api/v1/notes",
	bodyLimit({ maxSize: maxBodySize, onError: (c) => c.json({ error: "Payload too large" }, 413) }),
);
app.use(
	"/api/v1/notes/upload",
	bodyLimit({ maxSize: maxBodySize, onError: (c) => c.json({ error: "Payload too large" }, 413) }),
);
const chunkBodySize = CHUNK_SIZE + 1024; // chunk + overhead
app.use(
	"/api/v1/notes/upload/*/chunks/*",
	bodyLimit({
		maxSize: chunkBodySize,
		onError: (c) => c.json({ error: "Chunk too large" }, 413),
	}),
);

const notesRateLimit = createRateLimit({
	windowMs: 60_000,
	max: 30,
	trustedProxies: TRUSTED_PROXIES,
});
const notesDetailRateLimit = createRateLimit({
	windowMs: 60_000,
	max: 60,
	trustedProxies: TRUSTED_PROXIES,
});
const existsRateLimit = createRateLimit({
	windowMs: 60_000,
	max: 20,
	trustedProxies: TRUSTED_PROXIES,
});
const chunksRateLimit = createRateLimit({
	windowMs: 60_000,
	max: 200,
	trustedProxies: TRUSTED_PROXIES,
});
app.use("/api/v1/notes", notesRateLimit.middleware);
app.use("/api/v1/notes/*/exists", existsRateLimit.middleware);
app.use("/api/v1/notes/upload/*/chunks/*", chunksRateLimit.middleware);
app.use("/api/v1/notes/*", notesDetailRateLimit.middleware);

const writeAuth = createWriteAuth(API_KEYS);
app.use("/api/v1/notes/*", writeAuth);

app.use("*", async (c, next) => {
	c.set("db", db);
	c.set("serverKey", serverKey);
	c.set("storage", storage);
	c.set("chunkSize", CHUNK_SIZE);
	c.set("maxChunkedFileSize", MAX_CHUNKED_FILE_SIZE);
	await next();
});

// --- Unversioned routes ---

app.get("/api/health", (c) => {
	c.header("Cache-Control", "no-cache");
	return c.json({ status: "ok" });
});
app.get("/robots.txt", (c) => {
	c.header("Content-Type", "text/plain");
	c.header("Cache-Control", "public, max-age=86400");
	return c.body(
		`User-agent: *\nAllow: /\nDisallow: /note/\nDisallow: /api/\n\nSitemap: ${APP_URL}/sitemap.xml\n`,
	);
});
app.get("/sitemap.xml", (c) => {
	c.header("Content-Type", "application/xml");
	c.header("Cache-Control", "public, max-age=86400");
	return c.body(
		`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n  <url>\n    <loc>${APP_URL}/</loc>\n    <xhtml:link rel="alternate" hreflang="en" href="${APP_URL}/" />\n    <xhtml:link rel="alternate" hreflang="fr" href="${APP_URL}/" />\n    <xhtml:link rel="alternate" hreflang="x-default" href="${APP_URL}/" />\n    <changefreq>monthly</changefreq>\n    <priority>1.0</priority>\n  </url>\n</urlset>\n`,
	);
});

// --- Cap (internal, not versioned, not documented) ---

app.route("/api/cap", createCapRoutes());

// --- Versioned API (v1) ---

const v1 = new OpenAPIHono<AppEnv>();

v1.route("/notes", createNotesRoutes());

v1.get("/config", (c) => {
	return c.json({
		maxFileSize: CONFIGURED_MAX_FILE_SIZE,
		maxFilesPerNote: CONFIGURED_MAX_FILES,
		chunkSize: CHUNK_SIZE,
		maxChunkedFileSize: MAX_CHUNKED_FILE_SIZE,
	});
});

v1.doc31("/openapi.json", {
	openapi: "3.1.0",
	info: {
		title: "Secret API",
		version: "1.0.0",
		description:
			"Zero-knowledge encrypted note and file sharing API. Data is encrypted client-side before transmission; the server never sees plaintext.",
	},
});

v1.get(
	"/docs",
	Scalar({
		url: "/api/v1/openapi.json",
		theme: "kepler",
		_integration: "hono",
		telemetry: false,
	}),
);

app.route("/api/v1", v1);

// --- Cleanup & server ---

const cleanupTimer = startCleanupJob(db, storage, CLEANUP_MS);

const server = serve({ fetch: app.fetch, hostname: HOST, port: PORT });

function shutdown(): void {
	console.log("[shutdown] Graceful shutdown initiated");
	clearInterval(cleanupTimer);
	notesRateLimit.cleanup();
	notesDetailRateLimit.cleanup();
	existsRateLimit.cleanup();
	chunksRateLimit.cleanup();
	server.close(() => {
		sqlite.close();
		process.exit(0);
	});
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

console.log(`Secret API listening on ${HOST}:${String(PORT)} [storage=${STORAGE_BACKEND}]`);

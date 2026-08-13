import { OpenAPIHono } from "@hono/zod-openapi";
import { CAP_CHALLENGE_EXPIRES_MS, CAP_CHALLENGE_SIZE } from "@largerio/secret-shared";
import { Scalar } from "@scalar/hono-api-reference";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { compress } from "hono/compress";
import type { AppConfig } from "./config.js";
import type { AppDatabase } from "./db/index.js";
import { createHealthCheck } from "./health.js";
import { type Logger, log } from "./logger.js";
import { createWriteAuth } from "./middleware/auth.js";
import { createErrorHandler } from "./middleware/errorHandler.js";
import {
	classifyNotesPath,
	createRateLimit,
	type NotesRateClass,
	type RateLimitResult,
} from "./middleware/rateLimit.js";
import { createRequestId, createRequestLogger } from "./middleware/requestContext.js";
import {
	createCors,
	createDocsSecurityHeaders,
	createSecurityHeaders,
} from "./middleware/security.js";
import { createCapRoutes } from "./routes/cap.js";
import { createNotesRoutes } from "./routes/notes/index.js";
import type { StorageBackend } from "./storage/index.js";

export interface AppEnv {
	Variables: {
		db: AppDatabase;
		serverKey: Buffer;
		storage: StorageBackend;
		chunkSize: number;
		maxChunkedFileSize: number;
		maxExpirySeconds: number;
		maxFilesPerNote: number;
		storageQuotaBytes: number;
		requestId: string;
	};
}

export interface CreateAppDeps {
	readonly db: AppDatabase;
	readonly serverKey: Buffer;
	readonly storage: StorageBackend;
	readonly config: AppConfig;
	/** Injectable for tests; defaults to the process-wide structured logger. */
	readonly logger?: Logger;
}

export interface CreatedApp {
	readonly app: Hono<AppEnv>;
	/** Rate limiters whose sweep timers must be cleared on shutdown. */
	readonly rateLimiters: ReadonlyArray<RateLimitResult>;
}

/**
 * Assemble the Hono application: middleware, body limits, rate limiting, auth,
 * context injection, and all routes. Pure with respect to I/O — it neither
 * starts an HTTP server nor schedules the cleanup job, so it can be exercised
 * with `app.request()` in tests.
 */
export function createApp(deps: CreateAppDeps): CreatedApp {
	const { db, serverKey, storage, config } = deps;
	const logger = deps.logger ?? log;

	const app = new Hono<AppEnv>();

	app.onError(createErrorHandler({ debug: config.debug, logger }));

	app.notFound((c) => c.json({ error: "Not found" }, 404));

	// First so every later middleware, handler and the error handler can
	// correlate their log lines with this request. Health probes are skipped:
	// an orchestrator polling every few seconds would drown the log.
	app.use("*", createRequestId());
	app.use("*", createRequestLogger(logger, { skipPaths: ["/api/health"] }));

	app.use("/api/v1/docs", createDocsSecurityHeaders());
	app.use("*", createSecurityHeaders({ skipPaths: ["/api/v1/docs"] }));
	app.use("*", createCors([config.appUrl]));
	app.use("*", compress());

	// Hono matches `app.use(path)` against the exact path (not as a prefix), so
	// the JSON create endpoint (/api/v1/notes) and the multipart upload endpoint
	// (/api/v1/notes/upload) each need their own body-limit rule. Individual chunk
	// uploads get a tighter limit from the wildcard rule registered after them.
	const maxBodySize = config.maxFileSize * config.maxFilesPerNote + 1024 * 1024;
	app.use(
		"/api/v1/notes",
		bodyLimit({
			maxSize: maxBodySize,
			onError: (c) => c.json({ error: "Payload too large" }, 413),
		}),
	);
	app.use(
		"/api/v1/notes/upload",
		bodyLimit({
			maxSize: maxBodySize,
			onError: (c) => c.json({ error: "Payload too large" }, 413),
		}),
	);
	const chunkBodySize = config.chunkSize + 1024; // chunk + overhead
	app.use(
		"/api/v1/notes/upload/*/chunks/*",
		bodyLimit({
			maxSize: chunkBodySize,
			onError: (c) => c.json({ error: "Chunk too large" }, 413),
		}),
	);

	// Per-IP rate limits, one bound per endpoint class:
	//   create   30/min — the scarcest resource (every call stores a new note)
	//   read     60/min — reads, deletes and upload finalization
	//   exists   60/min — one per note opened; see below
	//   chunks  200/min — one upload fans out into many chunk requests
	//
	// `exists` used to be the tightest bound at 20/min, on the theory that it is
	// the cheapest endpoint to abuse. That traded a protection that does not
	// exist for a real outage: note IDs are 12-char nanoids (~72 bits), so
	// enumeration is impossible regardless of the limit (SECURITY.md says as
	// much), while *every* note page view spends one — so 20 note opens a minute
	// froze the endpoint for everyone sharing the bucket, which behind the
	// bundled reverse proxy means all users at once.
	//
	// rateLimitMultiplier scales every bound for deployments where many
	// legitimate users share one apparent address (corporate NAT, VPN, or a
	// proxy whose address is not in TRUSTED_PROXIES).
	const scale = (max: number) => Math.ceil(max * config.rateLimitMultiplier);
	const limit = (max: number) =>
		createRateLimit({ windowMs: 60_000, max: scale(max), trustedProxies: config.trustedProxies });

	const createLimit = limit(30);
	const readLimit = limit(60);
	const existsLimit = limit(60);
	const chunksLimit = limit(200);
	// One browser write costs 1 challenge + 1 redeem; 60/min stays generous for
	// multi-tab use while capping free Proof-of-Work challenge generation.
	const capRateLimit = limit(60);

	// One limiter per request (see classifyNotesPath): layering these as separate
	// app.use() rules stacked them, since Hono runs every middleware that matches.
	const notesPrefix = "/api/v1/notes";
	const byClass: Record<NotesRateClass, MiddlewareHandler> = {
		create: createLimit.middleware,
		read: readLimit.middleware,
		exists: existsLimit.middleware,
		chunks: chunksLimit.middleware,
	};
	const notesRateLimit: MiddlewareHandler = (c, next) =>
		byClass[classifyNotesPath(c.req.path)](c, next);
	app.use(notesPrefix, notesRateLimit);
	app.use(`${notesPrefix}/*`, notesRateLimit);

	// Reads return note ciphertext that may be burn-after-read: a 200 without
	// cache directives is heuristically cacheable (RFC 9111 §4.2.2), so a CDN or
	// the browser cache could replay a note after the row is destroyed.
	app.use(`${notesPrefix}/*`, async (c, next) => {
		await next();
		c.header("Cache-Control", "no-store");
	});

	const writeAuth = createWriteAuth(config.apiKeys);
	app.use("/api/v1/notes/*", writeAuth);

	app.use("*", async (c, next) => {
		c.set("db", db);
		c.set("serverKey", serverKey);
		c.set("storage", storage);
		c.set("chunkSize", config.chunkSize);
		c.set("maxChunkedFileSize", config.maxChunkedFileSize);
		c.set("maxExpirySeconds", config.maxExpirySeconds);
		c.set("maxFilesPerNote", config.maxFilesPerNote);
		c.set("storageQuotaBytes", config.storageQuotaBytes);
		await next();
	});

	// --- Unversioned routes ---

	const checkHealth = createHealthCheck(db, storage, {
		quotaBytes: config.storageQuotaBytes,
	});
	app.get("/api/health", async (c) => {
		c.header("Cache-Control", "no-store");
		const report = await checkHealth();
		return c.json(report, report.status === "ok" ? 200 : 503);
	});
	app.get("/robots.txt", (c) => {
		c.header("Content-Type", "text/plain");
		c.header("Cache-Control", "public, max-age=86400");
		return c.body(
			`User-agent: *\nAllow: /\nDisallow: /note/\nDisallow: /api/\n\nSitemap: ${config.appUrl}/sitemap.xml\n`,
		);
	});
	app.get("/sitemap.xml", (c) => {
		c.header("Content-Type", "application/xml");
		c.header("Cache-Control", "public, max-age=86400");
		return c.body(
			`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n  <url>\n    <loc>${config.appUrl}/</loc>\n    <xhtml:link rel="alternate" hreflang="en" href="${config.appUrl}/" />\n    <xhtml:link rel="alternate" hreflang="fr" href="${config.appUrl}/" />\n    <xhtml:link rel="alternate" hreflang="x-default" href="${config.appUrl}/" />\n    <changefreq>monthly</changefreq>\n    <priority>1.0</priority>\n  </url>\n</urlset>\n`,
		);
	});

	// --- Cap (internal, not versioned, not documented) ---

	app.use("/api/cap/*", capRateLimit.middleware);
	app.route(
		"/api/cap",
		createCapRoutes(undefined, {
			challengeCount: config.capChallengeCount,
			challengeSize: CAP_CHALLENGE_SIZE,
			challengeDifficulty: config.capDifficulty,
			expiresMs: CAP_CHALLENGE_EXPIRES_MS,
		}),
	);

	// --- Versioned API (v1) ---

	const v1 = new OpenAPIHono<AppEnv>();

	v1.route("/notes", createNotesRoutes());

	v1.get("/config", (c) => {
		return c.json({
			maxFileSize: config.maxFileSize,
			maxFilesPerNote: config.maxFilesPerNote,
			maxExpiry: config.maxExpirySeconds,
			chunkSize: config.chunkSize,
			maxChunkedFileSize: config.maxChunkedFileSize,
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

	return {
		app,
		rateLimiters: [createLimit, readLimit, existsLimit, chunksLimit, capRateLimit],
	};
}

import { OpenAPIHono } from "@hono/zod-openapi";
import { CAP_CHALLENGE_EXPIRES_MS, CAP_CHALLENGE_SIZE } from "@largerio/secret-shared";
import { Scalar } from "@scalar/hono-api-reference";
import { Hono, type MiddlewareHandler } from "hono";
import { compress } from "hono/compress";
import { type BuildInfo, UNKNOWN_BUILD } from "./buildInfo.js";
import type { AppConfig } from "./config.js";
import type { AppDatabase } from "./db/index.js";
import { createHealthCheck, createReadiness } from "./health.js";
import { type Logger, log } from "./logger.js";
import {
	type AppMetrics,
	createMetrics,
	createMetricsHandler,
	createRequestMetrics,
} from "./metrics.js";
import { createWriteAuth } from "./middleware/auth.js";
import { createBodyLimits } from "./middleware/bodyLimit.js";
import { createCloseAfterError } from "./middleware/connection.js";
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
		metrics: AppMetrics;
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
	/**
	 * Shared with what runs beside the app (the purge counter around the
	 * storage, the sweep); a fresh registry by default.
	 */
	readonly metrics?: AppMetrics;
	/** Version and revision, read at startup (readBuildInfo). */
	readonly build?: BuildInfo;
}

export interface CreatedApp {
	readonly app: Hono<AppEnv>;
	/** Rate limiters whose sweep timers must be cleared on shutdown. */
	readonly rateLimiters: ReadonlyArray<RateLimitResult>;
	/** Shutdown has begun: readiness answers 503 from now on. */
	readonly drain: () => void;
}

/** Probed every few seconds by orchestrators and load balancers. */
const HEALTH_PATHS = ["/api/health", "/api/health/live", "/api/health/ready"];

const METRICS_PATH = "/api/metrics";

/**
 * Assemble the Hono application: middleware, body limits, rate limiting, auth,
 * context injection, and all routes. Pure with respect to I/O — it neither
 * starts an HTTP server nor schedules the cleanup job, so it can be exercised
 * with `app.request()` in tests.
 */
export function createApp(deps: CreateAppDeps): CreatedApp {
	const { db, serverKey, storage, config } = deps;
	const logger = deps.logger ?? log;
	const build = deps.build ?? UNKNOWN_BUILD;
	const metrics =
		deps.metrics ?? createMetrics({ db, build, quotaBytes: config.storageQuotaBytes, logger });

	const app = new Hono<AppEnv>();

	app.onError(createErrorHandler({ debug: config.debug, logger }));

	app.notFound((c) => c.json({ error: "Not found" }, 404));

	// First so every later middleware, handler and the error handler can
	// correlate their log lines with this request. Health probes are skipped:
	// an orchestrator polling every few seconds would drown the log. So is a
	// scrape, unless it fails (a wrong token, say).
	app.use("*", createRequestId());
	app.use(
		"*",
		createRequestLogger(logger, { skipPaths: HEALTH_PATHS, quietPaths: [METRICS_PATH] }),
	);
	app.use("*", createRequestMetrics(metrics));

	app.use("/api/v1/docs", createDocsSecurityHeaders());
	app.use("*", createSecurityHeaders({ skipPaths: ["/api/v1/docs"] }));
	app.use("*", createCors([new URL(config.appUrl).origin]));
	app.use("*", compress());

	// Around the limits and the auth below, which answer before reading a body.
	app.use("*", createCloseAfterError());

	app.use(
		"*",
		createBodyLimits({
			note: config.maxFileSize * config.maxFilesPerNote + 1024 * 1024,
			chunk: config.chunkSize + 1024, // chunk + overhead
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
	// A single registration: Hono's `/notes/*` also matches `/notes` itself, so
	// adding `app.use(notesPrefix, …)` as well counted every JSON create twice
	// and halved its bound.
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
		c.set("metrics", metrics);
		await next();
	});

	// --- Unversioned routes ---

	app.use("/api/health/*", async (c, next) => {
		await next();
		c.header("Cache-Control", "no-store");
	});

	// Liveness: the process answers. It touches nothing, so a slow or failing
	// dependency never gets a working process restarted.
	app.get("/api/health/live", (c) => c.json({ status: "ok" as const }));

	// Readiness: the database and the storage answer, and no shutdown has begun.
	const readiness = createReadiness(createHealthCheck(db, storage));
	app.get("/api/health/ready", async (c) => {
		const report = await readiness.check();
		return c.json(report, report.status === "ok" ? 200 : 503);
	});

	// The readiness report, plus what an operator looks for. The volume stored
	// is not public: it is in the metrics.
	const quotaBytes = config.storageQuotaBytes > 0 ? config.storageQuotaBytes : null;
	app.get("/api/health", async (c) => {
		const report = await readiness.check();
		return c.json(
			{ ...report, storage: { quotaBytes }, version: build.version, revision: build.revision },
			report.status === "ok" ? 200 : 503,
		);
	});

	// Off unless METRICS_TOKEN is set: a 404, like any unknown route.
	if (config.metricsToken !== "") {
		app.get(METRICS_PATH, createMetricsHandler(metrics, config.metricsToken));
	}

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
			version: build.version,
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
		drain: readiness.drain,
	};
}

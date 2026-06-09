import { OpenAPIHono } from "@hono/zod-openapi";
import { CAP_CHALLENGE_EXPIRES_MS, CAP_CHALLENGE_SIZE } from "@largerio/shared";
import { Scalar } from "@scalar/hono-api-reference";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { compress } from "hono/compress";
import type { AppConfig } from "./config.js";
import type { AppDatabase } from "./db/index.js";
import { createWriteAuth } from "./middleware/auth.js";
import { createErrorHandler } from "./middleware/errorHandler.js";
import { createRateLimit, type RateLimitResult } from "./middleware/rateLimit.js";
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
	};
}

export interface CreateAppDeps {
	readonly db: AppDatabase;
	readonly serverKey: Buffer;
	readonly storage: StorageBackend;
	readonly config: AppConfig;
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

	const app = new Hono<AppEnv>();

	app.onError(createErrorHandler({ debug: config.debug }));

	app.notFound((c) => c.json({ error: "Not found" }, 404));

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

	// Per-IP rate limits, tuned per endpoint and layered by path specificity.
	// Hono applies every middleware whose path matches, so a request can pass
	// through several of these; the bounds below are chosen to make that stacking
	// harmless. Roughly: note create/list is the scarcest (30/min), generic
	// note reads are looser (60/min), existence probes are the tightest (20/min),
	// and chunk uploads are the most permissive (200/min) since one upload fans
	// out into many chunk requests.
	const notesRateLimit = createRateLimit({
		windowMs: 60_000,
		max: 30,
		trustedProxies: config.trustedProxies,
	});
	const notesDetailRateLimit = createRateLimit({
		windowMs: 60_000,
		max: 60,
		trustedProxies: config.trustedProxies,
	});
	const existsRateLimit = createRateLimit({
		windowMs: 60_000,
		max: 20,
		trustedProxies: config.trustedProxies,
	});
	const chunksRateLimit = createRateLimit({
		windowMs: 60_000,
		max: 200,
		trustedProxies: config.trustedProxies,
	});
	// One browser write costs 1 challenge + 1 redeem; 60/min stays generous for
	// multi-tab use while capping free Proof-of-Work challenge generation.
	const capRateLimit = createRateLimit({
		windowMs: 60_000,
		max: 60,
		trustedProxies: config.trustedProxies,
	});
	app.use("/api/v1/notes", notesRateLimit.middleware);
	app.use("/api/v1/notes/*/exists", existsRateLimit.middleware);
	app.use("/api/v1/notes/upload/*/chunks/*", chunksRateLimit.middleware);
	app.use("/api/v1/notes/*", notesDetailRateLimit.middleware);

	const writeAuth = createWriteAuth(config.apiKeys);
	app.use("/api/v1/notes/*", writeAuth);

	app.use("*", async (c, next) => {
		c.set("db", db);
		c.set("serverKey", serverKey);
		c.set("storage", storage);
		c.set("chunkSize", config.chunkSize);
		c.set("maxChunkedFileSize", config.maxChunkedFileSize);
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
		rateLimiters: [
			notesRateLimit,
			notesDetailRateLimit,
			existsRateLimit,
			chunksRateLimit,
			capRateLimit,
		],
	};
}

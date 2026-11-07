import type { MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";

type ContentSecurityPolicy = NonNullable<
	NonNullable<Parameters<typeof secureHeaders>[0]>["contentSecurityPolicy"]
>;

/**
 * The headers the API and the web app send alike. Only the CSP and the
 * resource policy tell them apart: the web app's documents run scripts that
 * the API's answers never hold, and other sites show a few of its files.
 */
function securityHeaders(
	contentSecurityPolicy: ContentSecurityPolicy,
	crossOriginResourcePolicy: "same-origin" | "cross-origin",
): MiddlewareHandler {
	return secureHeaders({
		contentSecurityPolicy,
		// SECURITY.md assumes the delivered JavaScript is intact: without HSTS a
		// network attacker could serve a backdoored bundle over plain HTTP on the
		// very first visit.
		strictTransportSecurity: "max-age=63072000; includeSubDomains; preload",
		crossOriginOpenerPolicy: "same-origin",
		crossOriginResourcePolicy,
		// The URL fragment is never sent in a Referer, but no-referrer also keeps
		// the note id out of third-party logs.
		referrerPolicy: "no-referrer",
		xContentTypeOptions: "nosniff",
		xFrameOptions: "DENY",
		permissionsPolicy: {
			camera: [],
			microphone: [],
			geolocation: [],
			gyroscope: [],
			magnetometer: [],
			accelerometer: [],
			payment: [],
			usb: [],
		},
	});
}

export interface SecurityHeadersOptions {
	readonly skipPaths?: ReadonlyArray<string>;
}

/** The API's answers. */
export function createSecurityHeaders(options: SecurityHeadersOptions = {}): MiddlewareHandler {
	const strict = securityHeaders(
		{
			defaultSrc: ["'none'"],
			scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
			styleSrc: ["'self'", "'unsafe-inline'"],
			imgSrc: ["'self'", "data:", "blob:"],
			connectSrc: ["'self'"],
			fontSrc: ["'self'"],
			workerSrc: ["'self'", "blob:"],
			mediaSrc: ["blob:"],
			frameSrc: ["blob:"],
			frameAncestors: ["'none'"],
			baseUri: ["'self'"],
			formAction: ["'self'"],
		},
		"same-origin",
	);

	const skip = new Set(options.skipPaths ?? []);
	if (skip.size === 0) return strict;

	return async (c, next) => {
		if (skip.has(c.req.path)) {
			await next();
			return;
		}
		return strict(c, next);
	};
}

/**
 * The web app's pages and files: the document policy SvelteKit used to send,
 * the boot script allowed by its hash. The notes Worker is one of these files,
 * so it runs under this policy too.
 *
 * @param scriptHashes `'sha256-…'` of every inline script the shell runs.
 * @param resourcePolicy `cross-origin` for the files other sites show (the
 *   link preview, the icon); `same-origin` for the rest.
 */
export function createSiteSecurityHeaders(
	scriptHashes: ReadonlyArray<string>,
	resourcePolicy: "same-origin" | "cross-origin",
): MiddlewareHandler {
	return securityHeaders(
		{
			defaultSrc: ["'none'"],
			scriptSrc: ["'self'", "'wasm-unsafe-eval'", ...scriptHashes],
			styleSrc: ["'self'", "'unsafe-inline'"],
			imgSrc: ["'self'", "data:", "blob:"],
			connectSrc: ["'self'"],
			fontSrc: ["'self'"],
			workerSrc: ["'self'", "blob:"],
			mediaSrc: ["'self'", "blob:"],
			objectSrc: ["'none'"],
			frameAncestors: ["'none'"],
			baseUri: ["'self'"],
			// The app never submits a form (the one <form> calls preventDefault),
			// so 'none' costs nothing and closes the exfiltration path a note
			// author could otherwise build with injected markup.
			formAction: ["'none'"],
			// No upgrade-insecure-requests: it rewrites every same-origin asset to
			// https, so an instance served over plain HTTP on a LAN address (a NAS
			// on http://<ip>:3000) never loaded its scripts or styles. Over HTTPS
			// the app already sends HSTS.
		},
		resourcePolicy,
	);
}

// Scalar renders inline scripts/styles and loads the runtime from jsdelivr, so
// the API-wide strict CSP would break it. This middleware sets a CSP narrow
// enough to still mitigate injection but permissive enough for the docs page.
export function createDocsSecurityHeaders(): MiddlewareHandler {
	return async (c, next) => {
		c.header(
			"Content-Security-Policy",
			"default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'unsafe-inline' https://cdn.jsdelivr.net; connect-src 'self' https://cdn.jsdelivr.net https://api.scalar.com; img-src 'self' data: https://cdn.jsdelivr.net; font-src *; frame-ancestors 'none'",
		);
		c.header("Referrer-Policy", "no-referrer");
		c.header("X-Content-Type-Options", "nosniff");
		c.header("X-Frame-Options", "DENY");
		await next();
	};
}

export function createCors(allowedOrigins: ReadonlyArray<string>): MiddlewareHandler {
	return cors({
		origin: [...allowedOrigins],
		allowMethods: ["GET", "POST", "PUT", "DELETE"],
		allowHeaders: [
			"Content-Type",
			"Authorization",
			"X-Delete-Token",
			"X-Cap-Token",
			"X-Chunk-Hash",
		],
		maxAge: 86400,
	});
}

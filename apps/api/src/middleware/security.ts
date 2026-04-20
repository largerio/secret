import type { MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";

export interface SecurityHeadersOptions {
	readonly skipPaths?: ReadonlyArray<string>;
}

export function createSecurityHeaders(options: SecurityHeadersOptions = {}): MiddlewareHandler {
	const strict = secureHeaders({
		contentSecurityPolicy: {
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
		strictTransportSecurity: "max-age=63072000; includeSubDomains; preload",
		crossOriginOpenerPolicy: "same-origin",
		crossOriginResourcePolicy: "same-origin",
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
		},
	});

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

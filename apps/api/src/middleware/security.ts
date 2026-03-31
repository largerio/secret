import type { MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";

export function createSecurityHeaders(): MiddlewareHandler {
	return secureHeaders({
		contentSecurityPolicy: {
			defaultSrc: ["'none'"],
			scriptSrc: ["'self'"],
			styleSrc: ["'self'", "'unsafe-inline'"],
			imgSrc: ["'self'", "data:", "blob:"],
			connectSrc: ["'self'"],
			fontSrc: ["'self'"],
			mediaSrc: ["blob:"],
			frameSrc: ["blob:"],
			frameAncestors: ["'none'"],
			baseUri: ["'self'"],
			formAction: ["'self'"],
		},
		crossOriginOpenerPolicy: "same-origin",
		crossOriginResourcePolicy: "same-origin",
		referrerPolicy: "no-referrer",
		xContentTypeOptions: "nosniff",
		xFrameOptions: "DENY",
	});
}

export function createCors(allowedOrigins: ReadonlyArray<string>): MiddlewareHandler {
	return cors({
		origin: [...allowedOrigins],
		allowMethods: ["GET", "POST", "DELETE"],
		allowHeaders: ["Content-Type", "X-Delete-Token"],
		maxAge: 86400,
	});
}

import { secureHeaders } from "hono/secure-headers";
import { cors } from "hono/cors";
import type { MiddlewareHandler } from "hono";

export function createSecurityHeaders(): MiddlewareHandler {
	return secureHeaders({
		contentSecurityPolicy: {
			defaultSrc: ["'none'"],
			scriptSrc: ["'self'"],
			styleSrc: ["'self'", "'unsafe-inline'"],
			imgSrc: ["'self'", "data:"],
			connectSrc: ["'self'"],
			fontSrc: ["'self'"],
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
		allowHeaders: ["Content-Type"],
		maxAge: 86400,
	});
}

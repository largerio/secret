import type { Context } from "hono";
import { negotiate } from "./encodings.js";
import type { SiteFile } from "./load.js";

const CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
	["js", "text/javascript; charset=utf-8"],
	["mjs", "text/javascript; charset=utf-8"],
	["css", "text/css; charset=utf-8"],
	["json", "application/json"],
	["svg", "image/svg+xml"],
	["png", "image/png"],
	["woff2", "font/woff2"],
	["woff", "font/woff"],
	// Without it, WebAssembly.instantiateStreaming refuses the solver of the proof of work.
	["wasm", "application/wasm"],
	["html", "text/html; charset=utf-8"],
	["txt", "text/plain; charset=utf-8"],
]);

/** By extension; a file of any other kind is served as bytes, which nosniff keeps that way. */
export function contentTypeOf(path: string): string {
	const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
	return CONTENT_TYPES.get(extension) ?? "application/octet-stream";
}

/**
 * Hashed names under `_app/immutable/` never change content, so a browser
 * keeps them for a year. What says which build is live (`_app/version.json`,
 * `bundle.json`) is revalidated every time; the rest, whose names a release
 * keeps (the favicon, the link preview, Cap's solver), for an hour.
 */
export function cacheControlOf(path: string): string {
	if (path.startsWith("_app/immutable/")) return "public, max-age=31536000, immutable";
	if (path === "_app/version.json" || path === "bundle.json") return "no-cache";
	return "public, max-age=3600";
}

/** If-None-Match compares weakly (RFC 9110 §13.1.2): a proxy that recompresses weakens the ETag. */
function matches(ifNoneMatch: string, etag: string): boolean {
	return ifNoneMatch
		.split(",")
		.map((tag) => tag.trim())
		.some((tag) => tag === "*" || tag.replace(/^W\//, "") === etag);
}

/**
 * The file, in the copy Accept-Encoding asks for, or 304 when the client holds
 * that copy already. Each copy has its ETag, so a 304 never confirms a copy
 * other than the one the client would be sent.
 */
export function serveFile(c: Context, file: SiteFile): Response {
	const copy = negotiate(c.req.header("accept-encoding"), file.encodings);
	const etag = copy?.etag ?? file.etag;
	c.header("Cache-Control", file.cacheControl);
	c.header("ETag", etag);
	if (file.encodings.length > 0) {
		c.header("Vary", "Accept-Encoding");
	}

	const ifNoneMatch = c.req.header("if-none-match");
	if (ifNoneMatch !== undefined && matches(ifNoneMatch, etag)) {
		return c.body(null, 304);
	}

	c.header("Content-Type", file.contentType);
	if (copy) {
		c.header("Content-Encoding", copy.encoding);
	}
	return c.body(copy?.body ?? file.body);
}

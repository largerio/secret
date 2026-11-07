import { BUNDLE_MANIFEST } from "@largerio/secret-shared/bundle";
import type { Context } from "hono";
import { compressedCopies, type EncodedBody, negotiate } from "./encodings.js";

/** The pages', and any HTML file's of the build. */
export const HTML_CONTENT_TYPE = "text/html; charset=utf-8";

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
	["html", HTML_CONTENT_TYPE],
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
	if (path === "_app/version.json" || path === BUNDLE_MANIFEST) return "no-cache";
	return "public, max-age=3600";
}

/**
 * The images at the root of the build, what `static/` holds (the link
 * preview, the icon): meant to be shown by other sites, a chat client that
 * loads a link's preview from the browser among them. They are the same for
 * every visitor, so Cross-Origin-Resource-Policy lets them go: cross-origin.
 * The app's own files keep same-origin, nobody else has a use for them.
 */
export function isEmbeddable(path: string, contentType: string): boolean {
	return !path.includes("/") && contentType.startsWith("image/");
}

/** A compressed copy of a file, with an ETag of its own: caches keep it apart from the file. */
export interface EncodedFile extends EncodedBody {
	readonly etag: string;
}

/** A file of the build, as it is served. */
export interface SiteFile {
	readonly body: Uint8Array<ArrayBuffer>;
	/** Strong, the file's SHA-256 in quotes. */
	readonly etag: string;
	readonly contentType: string;
	readonly cacheControl: string;
	/** Shown by other sites, so served with Cross-Origin-Resource-Policy: cross-origin. */
	readonly embeddable: boolean;
	/** Compressed at startup, brotli first: no request costs a compression. */
	readonly encodings: ReadonlyArray<EncodedFile>;
}

/**
 * The file of the build at `path` (relative to it, `/`-separated), ready to
 * serve: its type, caching and resource policy, and its compressed copies.
 * Its ETag is its SHA-256 in quotes, a copy's that and the copy's coding
 * (`"<sha256>-br"`), which serveFile matches.
 */
export function siteFile(path: string, body: Uint8Array<ArrayBuffer>, sha256: string): SiteFile {
	const contentType = contentTypeOf(path);
	return {
		body,
		etag: `"${sha256}"`,
		contentType,
		cacheControl: cacheControlOf(path),
		embeddable: isEmbeddable(path, contentType),
		encodings: compressedCopies(body, contentType).map((copy) => ({
			...copy,
			etag: `"${sha256}-${copy.encoding}"`,
		})),
	};
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

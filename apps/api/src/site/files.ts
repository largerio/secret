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

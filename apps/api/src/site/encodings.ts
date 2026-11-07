import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { headerQualities } from "@largerio/secret-shared/site";

export type Encoding = "br" | "gzip";

/** A body compressed once, sent as it is to every client that accepts its coding. */
export interface EncodedBody {
	readonly encoding: Encoding;
	readonly body: Uint8Array<ArrayBuffer>;
}

/**
 * On the web app's build (1.1 MB of text and WebAssembly), quality 9 takes
 * 50 ms at startup, 10 takes 0.4 s and 11 a second, for 20 and 29 KB less
 * out of the build's 930 KB as sent: on a NAS a few times slower, only 9
 * keeps a restart quick.
 */
const BROTLI_QUALITY = 9;

/**
 * Text and WebAssembly; images and fonts come compressed already, but for an
 * SVG, text too, and an icon, which mostly holds bitmaps.
 */
const COMPRESSIBLE = new Set([
	"text/javascript",
	"text/css",
	"text/html",
	"text/plain",
	"application/json",
	"application/manifest+json",
	"application/wasm",
	"image/svg+xml",
	"image/x-icon",
]);

/**
 * The copies of a body worth sending, compressed once rather than on every
 * request: brotli, the one to prefer, then gzip, each only when smaller than
 * the body. None for a type that does not compress.
 */
export function compressedCopies(
	body: Uint8Array,
	contentType: string,
): ReadonlyArray<EncodedBody> {
	if (!COMPRESSIBLE.has(contentType.replace(/;.*$/, ""))) return [];

	const copies: ReadonlyArray<EncodedBody> = [
		{
			encoding: "br",
			body: brotliCompressSync(body, {
				params: {
					[constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
					[constants.BROTLI_PARAM_SIZE_HINT]: body.length,
				},
			}),
		},
		{ encoding: "gzip", body: gzipSync(body, { level: 9 }) },
	];
	return copies.filter((copy) => copy.body.length < body.length);
}

/**
 * The copy to send for Accept-Encoding, in the order the copies come (brotli
 * before gzip), or undefined for the body itself. A coding given q=0 is
 * refused, and so is one the header does not name, unless `*` accepts it.
 */
export function negotiate<T extends EncodedBody>(
	acceptEncoding: string | undefined,
	copies: ReadonlyArray<T>,
): T | undefined {
	if (acceptEncoding === undefined) return undefined;

	const q = headerQualities(acceptEncoding);
	const others = q.get("*") ?? 0;
	return copies.find((copy) => (q.get(copy.encoding) ?? others) > 0);
}

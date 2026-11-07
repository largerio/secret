/**
 * The web app's fingerprint. The build writes `bundle.json` at the root of the
 * bundle (`apps/web/build`): the SHA-256 of every file in it but that one,
 * and a digest over them all, which each release publishes and the instance
 * answers in `/api/health`.
 *
 * The digest is the SHA-256 of the bundle's listing in `sha256sum`'s format,
 * so anyone can recompute it from a build, or from the files an instance
 * serves, with coreutils alone:
 *
 *   cd apps/web/build
 *   find . -type f ! -path ./bundle.json -printf '%P\n' | LC_ALL=C sort \
 *     | xargs -d '\n' sha256sum | sha256sum
 *
 * The build (`apps/web/scripts/bundle-manifest.ts`) and the server
 * (`apps/api/src/site/load.ts`) both read a bundle with `readBundle` and digest
 * it with `bundleDigest`: what the release publishes and what an instance
 * answers are computed the same way. Node only: the web app never imports it.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const BUNDLE_MANIFEST = "bundle.json";

export interface BundleFile {
	/** Relative to the bundle's root, `/`-separated, never `./`-prefixed. */
	readonly path: string;
	/** Lower-case hex. */
	readonly sha256: string;
	readonly size: number;
}

export interface BundleManifest {
	readonly version: 1;
	/** `sha256:` and the lower-case hex SHA-256 of `bundleListing(files)`. */
	readonly digest: string;
	/** Sorted by path, as in the listing. */
	readonly files: ReadonlyArray<BundleFile>;
}

/** By code unit, which for the ASCII paths of a build is `LC_ALL=C sort`'s byte order. */
function byPath(a: { readonly path: string }, b: { readonly path: string }): number {
	return a.path < b.path ? -1 : Number(a.path > b.path);
}

/** The files in the order the listing and the manifest keep them. */
export function sortBundleFiles<T extends { readonly path: string }>(
	files: ReadonlyArray<T>,
): ReadonlyArray<T> {
	return [...files].sort(byPath);
}

/** What `sha256sum` prints for the files: `<hex>  <path>`, a line each, sorted by path. */
export function bundleListing(files: ReadonlyArray<Pick<BundleFile, "path" | "sha256">>): string {
	return sortBundleFiles(files)
		.map((file) => `${file.sha256}  ${file.path}\n`)
		.join("");
}

function sha256Hex(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

/** The digest of a bundle: `sha256:` and the SHA-256 of its listing, the manifest left out. */
export function bundleDigest(files: ReadonlyArray<Pick<BundleFile, "path" | "sha256">>): string {
	return `sha256:${sha256Hex(bundleListing(files.filter((file) => file.path !== BUNDLE_MANIFEST)))}`;
}

/** A file of a bundle, read. */
export interface BundleEntry {
	/** Relative to the bundle's root, `/`-separated. */
	readonly path: string;
	readonly body: Buffer<ArrayBuffer>;
	/** Lower-case hex. */
	readonly sha256: string;
}

/**
 * Every file under `root`, read, the manifest included, in no order. Symbolic
 * links are left out, as `find -type f` leaves them out of the digest.
 */
export function readBundle(root: string): ReadonlyArray<BundleEntry> {
	return readdirSync(root, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => {
			const absolute = join(entry.parentPath, entry.name);
			const body = readFileSync(absolute);
			return {
				path: relative(root, absolute).split(sep).join("/"),
				body,
				sha256: sha256Hex(body),
			};
		});
}

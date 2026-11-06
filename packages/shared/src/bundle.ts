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
 */

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

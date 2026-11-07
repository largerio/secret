import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	BUNDLE_MANIFEST,
	type BundleManifest,
	bundleDigest,
	readBundle,
	sortBundleFiles,
} from "@largerio/secret-shared/bundle";
import { missingShellMarkers, SHELL_FILE } from "@largerio/secret-shared/site";

/**
 * What the build writes after `vite build` (`bundle-manifest.ts`):
 * `bundle.json`, the bundle's fingerprint (`@largerio/secret-shared/bundle`),
 * at the root of `build/`, once it has checked that the shell carries what
 * the server fills in.
 */

/** The manifest of the bundle in `dir`: every file but the manifest itself. */
export function bundleManifest(dir: string): BundleManifest {
	const files = readBundle(dir)
		.filter((file) => file.path !== BUNDLE_MANIFEST)
		.map(({ path, sha256, body }) => ({ path, sha256, size: body.length }));
	return { version: 1, digest: bundleDigest(files), files: sortBundleFiles(files) };
}

/**
 * The server serves pages only from a shell it can fill in: one without the
 * markers would leave every page without its language, theme and settings.
 * It serves the same shell at every path, so its assets must be named from
 * the root: `./_app/…` would be looked for under /note/<id>/ on a note's page.
 */
export function checkShell(html: string): void {
	const missing = missingShellMarkers(html);
	if (missing.length > 0) {
		throw new Error(`${SHELL_FILE} lacks ${missing.join(" and ")}: the server cannot fill it in`);
	}
	if (/(?:href=|src=|import\()"\.{1,2}\//.test(html)) {
		throw new Error(
			`${SHELL_FILE} names an asset relative to the page: it is served at every path`,
		);
	}
}

/** Checks the shell in `dir`, then writes its manifest there. */
export function writeBundleManifest(dir: string): BundleManifest {
	checkShell(readFileSync(join(dir, SHELL_FILE), "utf8"));
	const manifest = bundleManifest(dir);
	writeFileSync(join(dir, BUNDLE_MANIFEST), `${JSON.stringify(manifest, null, "\t")}\n`);
	return manifest;
}

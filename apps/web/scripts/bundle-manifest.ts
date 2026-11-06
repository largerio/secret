import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	BUNDLE_MANIFEST,
	type BundleFile,
	type BundleManifest,
	bundleListing,
	sortBundleFiles,
} from "@largerio/secret-shared/bundle";
import { SHELL_HEAD_MARKER, SHELL_HTML_TAG } from "@largerio/secret-shared/site";

/**
 * Run after `vite build`: writes `bundle.json`, the bundle's fingerprint
 * (`@largerio/secret-shared/bundle`), at the root of `build/`, once it has
 * checked that the shell carries what the server fills in.
 */

function sha256(data: string | Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

/** Every file under `dir`, relative to `root`, `/`-separated. */
async function filesUnder(root: string, dir = ""): Promise<string[]> {
	const entries = await readdir(join(root, dir), { withFileTypes: true });
	const nested = await Promise.all(
		entries.map((entry) => {
			const path = dir ? `${dir}/${entry.name}` : entry.name;
			if (entry.isDirectory()) return filesUnder(root, path);
			return entry.isFile() ? [path] : [];
		}),
	);
	return nested.flat();
}

/** The manifest of the bundle in `dir`: every file but the manifest itself. */
export async function bundleManifest(dir: string): Promise<BundleManifest> {
	const paths = (await filesUnder(dir)).filter((path) => path !== BUNDLE_MANIFEST);
	const files: BundleFile[] = await Promise.all(
		paths.map(async (path) => {
			const bytes = await readFile(join(dir, path));
			return { path, sha256: sha256(bytes), size: bytes.length };
		}),
	);
	const sorted = sortBundleFiles(files);
	return { version: 1, digest: `sha256:${sha256(bundleListing(sorted))}`, files: sorted };
}

/**
 * The server serves pages only from a shell it can fill in: one without the
 * markers would leave every page without its language, theme and settings.
 * It serves the same shell at every path, so its assets must be named from
 * the root: `./_app/…` would be looked for under /note/<id>/ on a note's page.
 */
export function checkShell(html: string): void {
	for (const marker of [SHELL_HTML_TAG, SHELL_HEAD_MARKER]) {
		if (!html.includes(marker)) {
			throw new Error(`index.html lacks ${marker}: the server cannot fill it in`);
		}
	}
	if (/(?:href=|src=|import\()"\.{1,2}\//.test(html)) {
		throw new Error("index.html names an asset relative to the page: it is served at every path");
	}
}

/** Checks the shell in `dir`, then writes its manifest there. */
export async function writeBundleManifest(dir: string): Promise<BundleManifest> {
	checkShell(await readFile(join(dir, "index.html"), "utf8"));
	const manifest = await bundleManifest(dir);
	await writeFile(join(dir, BUNDLE_MANIFEST), `${JSON.stringify(manifest, null, "\t")}\n`);
	return manifest;
}

if (import.meta.main) {
	const build = fileURLToPath(new URL("../build", import.meta.url));
	const manifest = await writeBundleManifest(build);
	console.log(`${BUNDLE_MANIFEST}: ${manifest.files.length} files, ${manifest.digest}`);
}

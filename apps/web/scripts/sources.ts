import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * What the web app's bundle is built from, relative to the repository's
 * root: its sources, the workspace packages it bundles from theirs, the
 * messages, and the lockfile, which pins every other dependency.
 */
export const BUNDLE_SOURCES: ReadonlyArray<string> = [
	"apps/web/package.json",
	"apps/web/scripts",
	"apps/web/src",
	"apps/web/static",
	"apps/web/tsconfig.json",
	"apps/web/vite.config.ts",
	"messages",
	"packages/crypto/package.json",
	"packages/crypto/src",
	"packages/sdk-js/package.json",
	"packages/sdk-js/src",
	"packages/shared/package.json",
	"packages/shared/src",
	"pnpm-lock.yaml",
	"tsconfig.base.json",
];

/** Never part of a build: installed packages, tests, and what macOS leaves in folders. */
function skipped(name: string): boolean {
	return (
		name === "node_modules" ||
		name === "__tests__" ||
		name === ".DS_Store" ||
		name.endsWith(".test.ts")
	);
}

/** The files under `path`, relative to `root`, `/`-separated. */
function filesUnder(root: string, path: string): string[] {
	const stats = statSync(join(root, path), { throwIfNoEntry: false });
	if (stats === undefined) return [];
	if (!stats.isDirectory()) return [path];
	return readdirSync(join(root, path))
		.filter((name) => !skipped(name))
		.flatMap((name) => filesUnder(root, `${path}/${name}`));
}

function sha256(data: string | Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

/**
 * A digest of the files under `entries`: each one's path and the SHA-256 of
 * its bytes, in code-unit order, so that it depends on nothing but them —
 * neither the time, nor the folder they are in, nor the order a file system
 * lists them in.
 */
export function sourcesDigest(root: string, entries: ReadonlyArray<string>): string {
	const files = entries.flatMap((entry) => filesUnder(root, entry));
	const listing = [...new Set(files)]
		.sort((a, b) => (a < b ? -1 : Number(a > b)))
		.map((path) => `${sha256(readFileSync(join(root, path)))}  ${path}\n`)
		.join("");
	return sha256(listing);
}

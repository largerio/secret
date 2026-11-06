import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { BUNDLE_MANIFEST, bundleListing } from "@largerio/secret-shared/bundle";
import {
	LOCALES,
	type Locale,
	SHELL_HEAD_MARKER,
	SHELL_HTML_TAG,
} from "@largerio/secret-shared/site";
import { type Logger, log } from "../logger.js";
import { cacheControlOf, contentTypeOf } from "./files.js";
import { inlineScriptHashes } from "./scripts.js";

/** The page every path of the web app is rendered from, SvelteKit's fallback. */
const SHELL_FILE = "index.html";

/** A language's messages, key to text, `{param}` placeholders left in. */
export type Catalog = Readonly<Record<string, string>>;

export type Messages = Readonly<Record<Locale, Catalog>>;

export interface SiteFile {
	readonly body: Uint8Array<ArrayBuffer>;
	/** Strong, the file's SHA-256 in quotes. */
	readonly etag: string;
	readonly contentType: string;
	readonly cacheControl: string;
}

/** The web app's build, read whole at startup: nothing is read from disk per request. */
export interface Site {
	/** `sha256:` and the hex digest of the files served, as bundle.ts defines it. */
	readonly digest: string;
	/** Every file by its URL path (`/_app/…`) but the shell, which is rendered. */
	readonly files: ReadonlyMap<string, SiteFile>;
	/** index.html, with its markers (SHELL_HTML_TAG, SHELL_HEAD_MARKER). */
	readonly shell: string;
	/** CSP sources (`'sha256-…'`) of the scripts the shell runs inline. */
	readonly scriptHashes: ReadonlyArray<string>;
	readonly messages: Messages;
}

/** The build or the messages cannot be served: the instance refuses to start. */
export class SiteError extends Error {
	readonly hint =
		"Build the web app again (pnpm build), or remove apps/web/build to serve the API alone.";

	constructor(message: string) {
		super(message);
		this.name = "SiteError";
	}
}

export interface SiteLocation {
	/** The web app's build, apps/web/build. */
	readonly buildDir: string;
	/** The repository's messages, one `<locale>.json` per language. */
	readonly messagesDir: string;
	readonly logger?: Logger;
}

interface BuildFile {
	/** Relative to the build, `/`-separated. */
	readonly path: string;
	readonly body: Buffer<ArrayBuffer>;
	readonly sha256: string;
}

function sha256Hex(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

/** Symbolic links aside, as `find -type f` leaves them out of the digest. */
function readBuild(root: string): ReadonlyArray<BuildFile> {
	return readdirSync(root, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => {
			const absolute = join(entry.parentPath, entry.name);
			const body = readFileSync(absolute);
			return { path: relative(root, absolute).split(sep).join("/"), body, sha256: sha256Hex(body) };
		});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The digest bundle.json records, or undefined when it is no manifest. */
function recordedDigest(manifest: Buffer): string | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(manifest.toString("utf8"));
	} catch {
		return undefined;
	}
	return isRecord(parsed) && typeof parsed["digest"] === "string" ? parsed["digest"] : undefined;
}

function readCatalog(path: string): Catalog {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (err) {
		throw new SiteError(`${path} cannot be read: ${(err as Error).message}`);
	}
	if (!isRecord(parsed)) {
		throw new SiteError(`${path} is not a catalog of messages`);
	}
	return Object.fromEntries(
		Object.entries(parsed).filter(
			(entry): entry is [string, string] => typeof entry[1] === "string",
		),
	);
}

function readMessages(dir: string): Messages {
	return Object.fromEntries(
		LOCALES.map((locale) => [locale, readCatalog(join(dir, `${locale}.json`))]),
	) as Messages;
}

/**
 * Read the web app's build and the messages its pages are rendered with.
 *
 * The digest is computed from the files read, never taken from bundle.json:
 * it is what /api/health answers, so it must name what is served. A
 * bundle.json that records another digest means the build was changed after
 * it was made, which an operator should hear of.
 *
 * @throws SiteError when index.html is not the shell, or a catalog is unreadable.
 */
export function loadSite(location: SiteLocation): Site {
	const logger = location.logger ?? log;
	const build = readBuild(location.buildDir);

	const digest = `sha256:${sha256Hex(bundleListing(build.filter((file) => file.path !== BUNDLE_MANIFEST)))}`;
	const manifest = build.find((file) => file.path === BUNDLE_MANIFEST);
	if (manifest) {
		const recorded = recordedDigest(manifest.body);
		if (recorded !== digest) {
			logger.warn("the web app was modified after its build: serving it as it is", {
				built: recorded ?? null,
				served: digest,
			});
		}
	}

	const shellFile = build.find((file) => file.path === SHELL_FILE);
	if (!shellFile) {
		throw new SiteError(`${join(location.buildDir, SHELL_FILE)} is missing`);
	}
	const shell = shellFile.body.toString("utf8");
	for (const marker of [SHELL_HTML_TAG, SHELL_HEAD_MARKER]) {
		if (!shell.includes(marker)) {
			throw new SiteError(`${join(location.buildDir, SHELL_FILE)} lacks ${marker}`);
		}
	}

	const files = new Map<string, SiteFile>();
	for (const file of build) {
		if (file.path === SHELL_FILE) continue;
		files.set(`/${file.path}`, {
			body: file.body,
			etag: `"${file.sha256}"`,
			contentType: contentTypeOf(file.path),
			cacheControl: cacheControlOf(file.path),
		});
	}

	return {
		digest,
		files,
		shell,
		scriptHashes: inlineScriptHashes(shell),
		messages: readMessages(location.messagesDir),
	};
}

/**
 * The web app, when it is built. Without a build the instance serves the API
 * alone: in development, where Vite serves the pages, that is expected; in
 * production it is worth a warning.
 */
export function loadBuiltSite(
	location: SiteLocation & { readonly production: boolean },
): Site | undefined {
	if (existsSync(join(location.buildDir, SHELL_FILE))) {
		return loadSite(location);
	}

	if (location.production) {
		(location.logger ?? log).warn("the web app is not built: serving the API alone", {
			buildDir: location.buildDir,
		});
	}
	return undefined;
}

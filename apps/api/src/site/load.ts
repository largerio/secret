import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	BUNDLE_MANIFEST,
	type BundleEntry,
	bundleDigest,
	readBundle,
} from "@largerio/secret-shared/bundle";
import {
	LOCALES,
	type Locale,
	missingShellMarkers,
	SHELL_FILE,
} from "@largerio/secret-shared/site";
import { type Logger, log } from "../logger.js";
import { type SiteFile, siteFile } from "./files.js";
import { inlineScriptHashes } from "./scripts.js";

/** A language's messages, key to text, `{param}` placeholders left in. */
export type Catalog = Readonly<Record<string, string>>;

export type Messages = Readonly<Record<Locale, Catalog>>;

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

/** What a SiteError comes from: the build, or the messages, which are sources. */
type SiteErrorSource = "build" | "messages";

const HINTS: Readonly<Record<SiteErrorSource, string>> = {
	build: "Build the web app again (pnpm build), or remove apps/web/build to serve the API alone.",
	messages:
		"messages/*.json are sources, which no build rewrites: fix the file, or restore it from the repository.",
};

/** The build or the messages cannot be served: the instance refuses to start. */
export class SiteError extends Error {
	readonly hint: string;

	constructor(message: string, source: SiteErrorSource) {
		super(message);
		this.name = "SiteError";
		this.hint = HINTS[source];
	}
}

export interface SiteLocation {
	/** The web app's build, apps/web/build. */
	readonly buildDir: string;
	/** The repository's messages, one `<locale>.json` per language. */
	readonly messagesDir: string;
	readonly logger?: Logger;
}

/** `read()`, a filesystem or parse error turned into the SiteError the instance stops on. */
function readOrRefuse<T>(path: string, source: SiteErrorSource, read: () => T): T {
	try {
		return read();
	} catch (err) {
		throw new SiteError(`${path} cannot be read: ${(err as Error).message}`, source);
	}
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

/**
 * The digest is computed from the files read, never taken from bundle.json:
 * it is what /api/health answers, so it must name what is served. A
 * bundle.json that records another digest means the build was changed after
 * it was made, which an operator should hear of.
 */
function warnOfChanges(build: ReadonlyArray<BundleEntry>, digest: string, logger: Logger): void {
	const manifest = build.find((file) => file.path === BUNDLE_MANIFEST);
	if (manifest === undefined) return;

	const recorded = recordedDigest(manifest.body);
	if (recorded !== digest) {
		logger.warn("the web app was modified after its build: serving it as it is", {
			built: recorded ?? null,
			served: digest,
		});
	}
}

/** index.html, refused unless the server can fill it in. */
function shellOf(build: ReadonlyArray<BundleEntry>, buildDir: string): string {
	const path = join(buildDir, SHELL_FILE);
	const file = build.find((entry) => entry.path === SHELL_FILE);
	if (file === undefined) {
		throw new SiteError(`${path} is missing`, "build");
	}

	const shell = file.body.toString("utf8");
	const missing = missingShellMarkers(shell);
	if (missing.length > 0) {
		throw new SiteError(`${path} lacks ${missing.join(" and ")}`, "build");
	}
	return shell;
}

function readCatalog(path: string): Catalog {
	const parsed: unknown = readOrRefuse(path, "messages", () =>
		JSON.parse(readFileSync(path, "utf8")),
	);
	if (!isRecord(parsed)) {
		throw new SiteError(`${path} is not a catalog of messages`, "messages");
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
 * @throws SiteError when the build or a catalog cannot be read, or index.html
 *   is not the shell.
 */
export function loadSite(location: SiteLocation): Site {
	const build = readOrRefuse(location.buildDir, "build", () => readBundle(location.buildDir));
	const digest = bundleDigest(build);
	warnOfChanges(build, digest, location.logger ?? log);
	const shell = shellOf(build, location.buildDir);

	// The copies are not the build's: the digest names the files they come from.
	const files = new Map<string, SiteFile>();
	for (const file of build) {
		if (file.path === SHELL_FILE) continue;
		files.set(`/${file.path}`, siteFile(file.path, file.body, file.sha256));
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

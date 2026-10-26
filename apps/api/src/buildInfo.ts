import { readFileSync } from "node:fs";

/**
 * What this build is, for `/api/health`, the OpenAPI document and
 * `secret_build_info`.
 *
 * The package.json files all say 1.0.0, and a release builds nothing: its tag
 * lands on a commit of main whose image already exists (release-image.yml). So
 * the version comes from the one file a release changes, CHANGELOG.md, read
 * from the image; and from the build, the commit and whether it is the release
 * that file names.
 */
export interface BuildInfo {
	/**
	 * The latest version in CHANGELOG.md; `<version>-dev` when built from a
	 * later commit of main; `unknown` without a changelog.
	 */
	readonly version: string;
	/** The commit built, or `unknown` (an image built without REVISION). */
	readonly revision: string;
}

export const UNKNOWN_BUILD: BuildInfo = { version: "unknown", revision: "unknown" };

/** `## [1.4.1] - 2026-10-26`: the first one is the latest release. */
const RELEASE_HEADING = /^## \[(\d+\.\d+\.\d+[^\]]*)\]/m;

const REVISION = /^[0-9a-f]{7,64}$/;

export function latestRelease(changelog: string): string | undefined {
	return RELEASE_HEADING.exec(changelog)?.[1];
}

/**
 * @param input.release `true` when CI built the release commit, `false` for
 *   any other commit of main, unset for a build outside CI.
 */
export function resolveBuildInfo(input: {
	readonly changelog: string | undefined;
	readonly release: string | undefined;
	readonly revision: string | undefined;
}): BuildInfo {
	const revision = input.revision?.trim().toLowerCase() ?? "";
	const latest = input.changelog === undefined ? undefined : latestRelease(input.changelog);

	let version = latest ?? UNKNOWN_BUILD.version;
	// Past a release, main still names it last: it must not pass for it.
	if (latest !== undefined && input.release?.trim() === "false") {
		version = `${latest}-dev`;
	}

	return { version, revision: REVISION.test(revision) ? revision : UNKNOWN_BUILD.revision };
}

/**
 * Read the build from the environment the Dockerfile sets (BUILD_REVISION,
 * BUILD_RELEASE) and the CHANGELOG.md at the repository or image root. Never
 * throws: a missing file reports an unknown version.
 */
export function readBuildInfo(
	env: NodeJS.ProcessEnv,
	changelogPath: URL = new URL("../../../CHANGELOG.md", import.meta.url),
): BuildInfo {
	let changelog: string | undefined;
	try {
		changelog = readFileSync(changelogPath, "utf8");
	} catch {
		changelog = undefined;
	}
	return resolveBuildInfo({
		changelog,
		release: env["BUILD_RELEASE"],
		revision: env["BUILD_REVISION"],
	});
}

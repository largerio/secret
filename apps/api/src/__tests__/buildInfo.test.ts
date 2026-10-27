import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { latestRelease, readBuildInfo, resolveBuildInfo, UNKNOWN_BUILD } from "../buildInfo.js";

const CHANGELOG = `# Changelog

## [Unreleased]

### Fixed

- Something not released yet.

## [1.4.1] - 2026-10-26

## [1.4.0] - 2026-10-26

[Unreleased]: https://github.com/largerio/secret/compare/v1.4.1...HEAD
[1.4.1]: https://github.com/largerio/secret/releases/tag/v1.4.1
`;

const REVISION = "137e9fa2d3a255df7e7557690f025d34857e4443";

describe("latestRelease", () => {
	it("takes the first version heading, past Unreleased", () => {
		expect(latestRelease(CHANGELOG)).toBe("1.4.1");
	});

	it("keeps a pre-release suffix", () => {
		expect(latestRelease("## [2.0.0-rc.1] - 2027-01-01\n## [1.4.1]")).toBe("2.0.0-rc.1");
	});

	it("finds nothing in a changelog without a release", () => {
		expect(latestRelease("# Changelog\n\n## [Unreleased]\n")).toBeUndefined();
	});
});

describe("resolveBuildInfo", () => {
	it("reports the release CI built from its release commit", () => {
		expect(resolveBuildInfo({ changelog: CHANGELOG, release: "true", revision: REVISION })).toEqual(
			{
				version: "1.4.1",
				revision: REVISION,
			},
		);
	});

	it("marks a later commit of main as past that release", () => {
		expect(
			resolveBuildInfo({ changelog: CHANGELOG, release: "false", revision: REVISION }).version,
		).toBe("1.4.1-dev");
	});

	it("reports the changelog's version as is for a build outside CI", () => {
		expect(
			resolveBuildInfo({ changelog: CHANGELOG, release: undefined, revision: undefined }),
		).toEqual({ version: "1.4.1", revision: "unknown" });
	});

	it("reports an unknown version without a changelog to read", () => {
		expect(
			resolveBuildInfo({ changelog: undefined, release: "false", revision: REVISION }).version,
		).toBe("unknown");
		expect(
			resolveBuildInfo({ changelog: "# Changelog\n", release: "false", revision: "" }),
		).toEqual(UNKNOWN_BUILD);
	});

	it("normalizes the revision and refuses anything but a commit hash", () => {
		const resolve = (revision: string) =>
			resolveBuildInfo({ changelog: CHANGELOG, release: "true", revision }).revision;

		expect(resolve(` ${REVISION.toUpperCase()}\n`)).toBe(REVISION);
		expect(resolve("137e9fa")).toBe("137e9fa");
		expect(resolve("137e9f")).toBe("unknown");
		expect(resolve('main"} 1')).toBe("unknown");
	});
});

describe("readBuildInfo", () => {
	it("reads the repository's CHANGELOG.md and the build variables", () => {
		const changelog = readFileSync(new URL("../../../../CHANGELOG.md", import.meta.url), "utf8");

		const build = readBuildInfo({ BUILD_RELEASE: "false", BUILD_REVISION: REVISION });

		expect(build).toEqual({
			version: `${String(latestRelease(changelog))}-dev`,
			revision: REVISION,
		});
		expect(build.version).toMatch(/^\d+\.\d+\.\d+/);
	});

	it("falls back to an unknown version when the changelog is missing", () => {
		const missing = new URL("./no-such-CHANGELOG.md", import.meta.url);

		expect(readBuildInfo({}, missing)).toEqual(UNKNOWN_BUILD);
	});
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { latestRelease } from "../apps/api/src/buildInfo.js";

/**
 * The API reads its version from CHANGELOG.md at the root of the image
 * (apps/api/src/buildInfo.ts). `.dockerignore` leaves every other Markdown file
 * out of the build: without the exception, every image would report an
 * `unknown` version, and nothing else would notice.
 */

const repoRoot = new URL("../", import.meta.url);

function read(name: string): string {
	return readFileSync(fileURLToPath(new URL(name, repoRoot)), "utf8");
}

describe("the version the image reports", () => {
	it("comes from a CHANGELOG.md that names a release", () => {
		expect(latestRelease(read("CHANGELOG.md"))).toMatch(/^\d+\.\d+\.\d+/);
	});

	it("is read from a CHANGELOG.md the image ships", () => {
		const ignored = read(".dockerignore").split("\n");

		expect(ignored.indexOf("!CHANGELOG.md")).toBeGreaterThan(ignored.indexOf("*.md"));
		expect(read("Dockerfile")).toMatch(/^COPY [^\n]*\bCHANGELOG\.md \.\/$/m);
	});
});

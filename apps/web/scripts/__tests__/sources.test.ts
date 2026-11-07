// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUNDLE_SOURCES, sourcesDigest } from "../sources.ts";

let root: string;

function sha256(data: string | Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

function write(path: string, contents: string): void {
	mkdirSync(join(root, path, ".."), { recursive: true });
	writeFileSync(join(root, path), contents);
}

/** A repository with sources, and what is never part of a build. */
function writeRepository(): void {
	write("app/src/a.ts", "a");
	write("app/src/lib/b.ts", "b");
	write("app/package.json", "{}");
	write("app/src/__tests__/a.test.ts", "test");
	write("app/src/lib/b.test.ts", "test");
	write("app/src/node_modules/x/index.js", "dependency");
	write("app/src/.DS_Store", "finder");
}

const ENTRIES = ["app/src", "app/package.json", "app/missing"];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "secret-sources-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("sourcesDigest", () => {
	it("is the same for the same sources, wherever they are", () => {
		writeRepository();
		const digest = sourcesDigest(root, ENTRIES);
		expect(digest).toMatch(/^[0-9a-f]{64}$/);

		const elsewhere = root;
		root = mkdtempSync(join(tmpdir(), "secret-sources-"));
		writeRepository();
		expect(sourcesDigest(root, [...ENTRIES].reverse())).toBe(digest);
		rmSync(elsewhere, { recursive: true, force: true });
	});

	it("digests the listing sha256sum prints for the sources", () => {
		writeRepository();
		const listing = ["app/package.json", "app/src/a.ts", "app/src/lib/b.ts"]
			.map((path) => `${sha256(readFileSync(join(root, path)))}  ${path}\n`)
			.join("");
		expect(sourcesDigest(root, ENTRIES)).toBe(sha256(listing));
	});

	it("changes with a source's contents, or its name", () => {
		writeRepository();
		const digest = sourcesDigest(root, ENTRIES);

		write("app/src/a.ts", "a2");
		const edited = sourcesDigest(root, ENTRIES);
		expect(edited).not.toBe(digest);

		rmSync(join(root, "app/src/a.ts"));
		write("app/src/c.ts", "a2");
		expect(sourcesDigest(root, ENTRIES)).not.toBe(edited);
	});

	it("ignores tests, installed packages and the file system's leftovers", () => {
		writeRepository();
		const digest = sourcesDigest(root, ENTRIES);

		write("app/src/__tests__/a.test.ts", "another test");
		write("app/src/lib/b.test.ts", "another test");
		write("app/src/node_modules/x/index.js", "another version");
		write("app/src/.DS_Store", "another view");
		expect(sourcesDigest(root, ENTRIES)).toBe(digest);
	});

	it("names the web app's own sources among what it is built from", () => {
		expect(BUNDLE_SOURCES).toEqual(
			expect.arrayContaining(["apps/web/src", "apps/web/static", "messages", "pnpm-lock.yaml"]),
		);
	});
});

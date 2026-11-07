import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	BUNDLE_MANIFEST,
	bundleDigest,
	bundleListing,
	readBundle,
	sortBundleFiles,
} from "../bundle.js";

const a = "a".repeat(64);
const b = "b".repeat(64);
const c = "c".repeat(64);

describe("bundleListing", () => {
	it("prints sha256sum's lines, sorted by path in byte order", () => {
		const listing = bundleListing([
			{ path: "index.html", sha256: a },
			{ path: "_app/immutable/start.js", sha256: b },
			{ path: "Z.txt", sha256: c },
		]);

		// "Z" (0x5a) < "_" (0x5f) < "i" (0x69), as LC_ALL=C sort orders them.
		expect(listing).toBe(`${c}  Z.txt\n${b}  _app/immutable/start.js\n${a}  index.html\n`);
	});

	it("is empty for no files", () => {
		expect(bundleListing([])).toBe("");
	});
});

describe("sortBundleFiles", () => {
	it("sorts a copy and keeps equal paths in place", () => {
		const files = [
			{ path: "b", size: 2 },
			{ path: "a", size: 1 },
			{ path: "b", size: 3 },
		];

		expect(sortBundleFiles(files)).toEqual([
			{ path: "a", size: 1 },
			{ path: "b", size: 2 },
			{ path: "b", size: 3 },
		]);
		expect(files[0]?.path).toBe("b");
	});
});

describe("bundleDigest", () => {
	it("is the SHA-256 of the listing, as sha256sum | sha256sum prints it", () => {
		const files = [
			{ path: "index.html", sha256: a },
			{ path: "_app/start.js", sha256: b },
		];
		const expected = createHash("sha256").update(bundleListing(files)).digest("hex");

		expect(bundleDigest(files)).toBe(`sha256:${expected}`);
	});

	it("leaves the manifest out, which cannot record its own digest", () => {
		const files = [{ path: "index.html", sha256: a }];

		expect(bundleDigest([...files, { path: BUNDLE_MANIFEST, sha256: c }])).toBe(
			bundleDigest(files),
		);
	});
});

describe("readBundle", () => {
	let root: string | undefined;

	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true });
		root = undefined;
	});

	it("reads every file under the root, by its /-separated path, symbolic links aside", () => {
		root = mkdtempSync(join(tmpdir(), "bundle-"));
		mkdirSync(join(root, "_app", "immutable"), { recursive: true });
		writeFileSync(join(root, "index.html"), "<html>");
		writeFileSync(join(root, "_app", "immutable", "start.js"), "start");
		symlinkSync(join(root, "index.html"), join(root, "link.html"));

		const files = sortBundleFiles(readBundle(root));

		expect(files.map((file) => file.path)).toEqual(["_app/immutable/start.js", "index.html"]);
		expect(files[1]?.body.toString()).toBe("<html>");
		expect(files[1]?.sha256).toBe(createHash("sha256").update("<html>").digest("hex"));
	});
});

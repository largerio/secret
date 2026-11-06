import { describe, expect, it } from "vitest";
import { bundleListing, sortBundleFiles } from "../bundle.js";

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

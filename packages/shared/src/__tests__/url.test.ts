import { describe, expect, it } from "vitest";
import { withoutTrailingSlashes } from "../url.js";

describe("withoutTrailingSlashes", () => {
	it.each([
		["https://a.example", "https://a.example"],
		["https://a.example/", "https://a.example"],
		["https://a.example///", "https://a.example"],
		["https://a.example/sub/", "https://a.example/sub"],
		["/", ""],
		["", ""],
	])("turns %j into %j", (url, expected) => {
		expect(withoutTrailingSlashes(url)).toBe(expected);
	});

	it("keeps the slashes that are not trailing", () => {
		expect(withoutTrailingSlashes("https://a.example//x")).toBe("https://a.example//x");
	});
});

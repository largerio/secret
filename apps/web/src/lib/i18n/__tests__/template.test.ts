import { describe, expect, it } from "vitest";
import { splitTemplate } from "../template.js";

describe("splitTemplate", () => {
	it("splits a sentence around its placeholders", () => {
		expect(splitTemplate("Destroy after {reads} or in {expiry}")).toEqual([
			{ text: "Destroy after " },
			{ slot: "reads" },
			{ text: " or in " },
			{ slot: "expiry" },
		]);
	});

	it("follows the translation's word order", () => {
		expect(splitTemplate("{expiry}後または{reads}後に削除")).toEqual([
			{ slot: "expiry" },
			{ text: "後または" },
			{ slot: "reads" },
			{ text: "後に削除" },
		]);
	});

	it("returns plain text untouched", () => {
		expect(splitTemplate("No slots here.")).toEqual([{ text: "No slots here." }]);
		expect(splitTemplate("")).toEqual([]);
	});
});

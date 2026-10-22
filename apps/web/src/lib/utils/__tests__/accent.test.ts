import { describe, expect, it } from "vitest";
import { accentStyle, contrastRatio } from "../accent.js";

describe("accentStyle", () => {
	it("keeps the theme's accent when no colour is set", () => {
		expect(accentStyle("")).toBeUndefined();
	});

	it("ignores anything that is not a hex colour, since it lands in a style attribute", () => {
		expect(accentStyle("red")).toBeUndefined();
		expect(accentStyle("#12345")).toBeUndefined();
		expect(accentStyle("#000;background:url(https://evil.example)")).toBeUndefined();
	});

	it("derives every accent token from one colour", () => {
		expect(accentStyle("#1D4ED8")).toBe(
			[
				"--accent:#1d4ed8",
				"--accent-strong:#1d4ed8",
				"--accent-ink:#ffffff",
				"--accent-soft:color-mix(in srgb, #1d4ed8 16%, transparent)",
				"--accent-ring:color-mix(in srgb, #1d4ed8 40%, transparent)",
			].join(";"),
		);
	});

	it("expands the short form and tolerates surrounding spaces", () => {
		expect(accentStyle(" #fc0 ")).toContain("--accent:#ffcc00");
	});

	it("puts dark text on a light colour and white text on a dark one", () => {
		expect(accentStyle("#ffcc00")).toContain("--accent-ink:#14140f");
		expect(accentStyle("#1d4ed8")).toContain("--accent-ink:#ffffff");
	});
});

describe("contrastRatio", () => {
	it("matches the WCAG reference values", () => {
		expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
		expect(contrastRatio([255, 255, 255], [0, 0, 0])).toBeCloseTo(21, 5);
		expect(contrastRatio([119, 119, 119], [255, 255, 255])).toBeCloseTo(4.48, 2);
	});
});

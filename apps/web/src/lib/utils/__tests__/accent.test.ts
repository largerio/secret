import { describe, expect, it } from "vitest";
import { accentStyle, contrastRatio } from "../accent.js";

type Rgb = [number, number, number];

/** Pull one custom property out of the declaration list, as channels. */
function token(style: string | undefined, name: string): Rgb {
	const value = style
		?.split(";")
		.find((declaration) => declaration.startsWith(`${name}:`))
		?.slice(name.length + 1);
	if (!value) throw new Error(`${name} missing from ${style}`);
	return [1, 3, 5].map((i) => Number.parseInt(value.slice(i, i + 2), 16)) as Rgb;
}

function hue([r, g, b]: Rgb): number {
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const d = max - min;
	const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
	return h * 60;
}

const WHITE: Rgb = [255, 255, 255];
const DARK_BG: Rgb = [0x09, 0x09, 0x0b];

describe("accentStyle", () => {
	it("keeps the built-in accent when no colour is set", () => {
		expect(accentStyle("")).toBeUndefined();
	});

	it("ignores anything that is not a hex colour, since it lands in a style attribute", () => {
		expect(accentStyle("red")).toBeUndefined();
		expect(accentStyle("#12345")).toBeUndefined();
		expect(accentStyle("#000;background:url(https://evil.example)")).toBeUndefined();
	});

	it("derives every brand token from one colour", () => {
		expect(accentStyle("#4F46E5")).toBe(
			[
				"--brand:#4f46e5",
				"--brand-2:#7733e2",
				"--brand-ink:#ffffff",
				"--brand-dk:#4f46e5",
				"--brand-2-dk:#7733e2",
				"--brand-ink-dk:#ffffff",
				"--brand-qr:#36309c",
				"--brand-2-qr:#51239a",
			].join(";"),
		);
	});

	it("expands the short form and tolerates surrounding spaces", () => {
		expect(accentStyle(" #fc0 ")).toContain("--brand:#ffcc00");
	});

	it("puts dark text on a light colour and white text on a dark one", () => {
		expect(accentStyle("#ffcc00")).toContain("--brand-ink:#17171c");
		expect(accentStyle("#1d4ed8")).toContain("--brand-ink:#ffffff");
	});

	it("turns the second stop towards pink for reds and towards violet otherwise", () => {
		const red = accentStyle("#dc2626");
		expect(hue(token(red, "--brand-2"))).toBeGreaterThan(330);

		const blue = accentStyle("#2563eb");
		expect(hue(token(blue, "--brand-2"))).toBeGreaterThan(hue(token(blue, "--brand")));
	});

	it.each(["#f97316", "#84cc16", "#22c55e", "#06b6d4", "#2563eb", "#dc2626"])(
		"keeps the luminance of %s on the second stop, so its text stays readable",
		(color) => {
			const style = accentStyle(color);
			const ink = style?.includes("--brand-ink:#ffffff") ? WHITE : ([0x17, 0x17, 0x1c] as Rgb);
			const first = contrastRatio(token(style, "--brand"), ink);
			const second = contrastRatio(token(style, "--brand-2"), ink);
			expect(Math.abs(first - second)).toBeLessThan(0.15);
		},
	);

	it("leaves greys alone instead of inventing a hue", () => {
		expect(accentStyle("#777777")).toContain("--brand-2:#777777");
	});

	it("lightens a colour that would vanish on the dark theme's background", () => {
		const style = accentStyle("#000000");
		expect(contrastRatio(token(style, "--brand-dk"), DARK_BG)).toBeGreaterThanOrEqual(3);
		expect(contrastRatio(token(style, "--brand-2-dk"), DARK_BG)).toBeGreaterThanOrEqual(3);
		expect(style).toContain("--brand-ink-dk:#ffffff");
	});

	it("darkens QR shades until they stand out on a white plate", () => {
		const style = accentStyle("#ffcc00");
		expect(contrastRatio(token(style, "--brand-qr"), WHITE)).toBeGreaterThanOrEqual(10);
		expect(contrastRatio(token(style, "--brand-2-qr"), WHITE)).toBeGreaterThanOrEqual(10);
	});
});

describe("contrastRatio", () => {
	it("matches the WCAG reference values", () => {
		expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
		expect(contrastRatio([255, 255, 255], [0, 0, 0])).toBeCloseTo(21, 5);
		expect(contrastRatio([119, 119, 119], [255, 255, 255])).toBeCloseTo(4.48, 2);
	});
});

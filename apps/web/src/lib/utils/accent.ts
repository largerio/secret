type Rgb = readonly [number, number, number];

const WHITE: Rgb = [255, 255, 255];
const INK_DARK = "#14140f";
const INK_DARK_RGB: Rgb = [0x14, 0x14, 0x0f];

function parseHex(color: string): Rgb | undefined {
	const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
	if (!match?.[1]) return undefined;

	const digits = match[1].length === 3 ? [...match[1]].map((d) => d + d).join("") : match[1];
	return [
		Number.parseInt(digits.slice(0, 2), 16),
		Number.parseInt(digits.slice(2, 4), 16),
		Number.parseInt(digits.slice(4, 6), 16),
	];
}

/** WCAG 2 relative luminance. */
function luminance([r, g, b]: Rgb): number {
	const linear = (channel: number) => {
		const c = channel / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG 2 contrast ratio, from 1 to 21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
	const la = luminance(a);
	const lb = luminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * CSS custom properties that recolour the interface from APP_PRIMARY_COLOR.
 *
 * Only a hex colour is accepted: the value lands in a style attribute, so
 * anything else is ignored rather than passed through. Text on solid accent
 * buttons is white or near-black, whichever contrasts more with the colour.
 *
 * @returns A style declaration list, or undefined to keep the theme's accent.
 */
export function accentStyle(color: string): string | undefined {
	const rgb = parseHex(color);
	if (!rgb) return undefined;

	const hex = `#${rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
	const ink = contrastRatio(rgb, WHITE) >= contrastRatio(rgb, INK_DARK_RGB) ? "#ffffff" : INK_DARK;

	return [
		`--accent:${hex}`,
		`--accent-strong:${hex}`,
		`--accent-ink:${ink}`,
		`--accent-soft:color-mix(in srgb, ${hex} 16%, transparent)`,
		`--accent-ring:color-mix(in srgb, ${hex} 40%, transparent)`,
	].join(";");
}

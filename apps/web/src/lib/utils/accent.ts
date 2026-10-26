type Rgb = readonly [number, number, number];

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];
const INK_DARK = "#17171c";
const INK_DARK_RGB: Rgb = [0x17, 0x17, 0x1c];
// The dark theme's background (app.css): a dark-theme accent must stand out from it.
const DARK_BG: Rgb = [0x09, 0x09, 0x0b];

// WCAG 2's floor for UI components against their surroundings.
const MIN_UI_CONTRAST = 3;
// QR modules against the white plate: well above what scanners need in poor light.
const MIN_QR_CONTRAST = 10;
const HUE_SHIFT = 20;

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

function toHex(rgb: Rgb): string {
	return `#${rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
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

/** Linear blend in sRGB, `amount` of the way from `from` to `to`. */
function mix([r1, g1, b1]: Rgb, [r2, g2, b2]: Rgb, amount: number): Rgb {
	const lerp = (a: number, b: number) => Math.round(a + (b - a) * amount);
	return [lerp(r1, r2), lerp(g1, g2), lerp(b1, b2)];
}

/** Move towards `target` until the colour reaches `ratio` against `against`. */
function pushToContrast(color: Rgb, target: Rgb, against: Rgb, ratio: number): Rgb {
	let result = color;
	for (let step = 1; step <= 50 && contrastRatio(result, against) < ratio; step++) {
		result = mix(color, target, step / 50);
	}
	return result;
}

function rgbToHsl([r, g, b]: Rgb): [number, number, number] {
	const rn = r / 255;
	const gn = g / 255;
	const bn = b / 255;
	const max = Math.max(rn, gn, bn);
	const min = Math.min(rn, gn, bn);
	const l = (max + min) / 2;
	const d = max - min;
	if (d === 0) return [0, 0, l];

	const s = d / (1 - Math.abs(2 * l - 1));
	const h =
		max === rn ? ((gn - bn) / d + 6) % 6 : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
	return [h * 60, s, l];
}

function hslToRgb(h: number, s: number, l: number): Rgb {
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
	const m = l - c / 2;
	const [r, g, b] =
		h < 60
			? [c, x, 0]
			: h < 120
				? [x, c, 0]
				: h < 180
					? [0, c, x]
					: h < 240
						? [0, x, c]
						: h < 300
							? [x, 0, c]
							: [c, 0, x];
	const channel = (v: number) => Math.round((v + m) * 255);
	return [channel(r), channel(g), channel(b)];
}

/**
 * The second stop of the accent gradient: the same colour turned 20° round
 * the wheel (reds and oranges towards pink, everything else towards violet),
 * then brought back to the original luminance. Text that reads on one stop
 * therefore reads on the other.
 */
function secondColor(rgb: Rgb): Rgb {
	const [h, s, l] = rgbToHsl(rgb);
	const hue = h < 60 || h >= 300 ? (h - HUE_SHIFT + 360) % 360 : h + HUE_SHIFT;
	const target = luminance(rgb);

	let low = 0;
	let high = 1;
	let result = hslToRgb(hue, s, l);
	for (let i = 0; i < 24; i++) {
		const mid = (low + high) / 2;
		result = hslToRgb(hue, s, mid);
		if (luminance(result) < target) low = mid;
		else high = mid;
	}
	return result;
}

/** White or near-black, whichever stays most readable across every stop. */
function inkFor(stops: readonly Rgb[]): string {
	const worst = (ink: Rgb) => Math.min(...stops.map((stop) => contrastRatio(stop, ink)));
	return worst(WHITE) >= worst(INK_DARK_RGB) ? "#ffffff" : INK_DARK;
}

/**
 * CSS custom properties that recolour the interface from APP_PRIMARY_COLOR.
 *
 * Only a hex colour is accepted: the value lands in a style attribute, so
 * anything else is ignored rather than passed through. Every derived value is
 * computed here from the parsed channels, never from the raw input.
 *
 * - `--brand`, `--brand-2`: the gradient's two stops; `--brand-ink`, the text on it.
 * - `--brand-dk*`: the same for the dark theme, lightened when the colour would
 *   vanish against its near-black background.
 * - `--brand-qr`, `--brand-2-qr`: darkened shades for QR codes on a white plate.
 *
 * @returns A style declaration list, or undefined to keep the built-in indigo.
 */
export function accentStyle(color: string): string | undefined {
	const brand = parseHex(color);
	if (!brand) return undefined;

	const brand2 = secondColor(brand);
	const dark = pushToContrast(brand, WHITE, DARK_BG, MIN_UI_CONTRAST);
	const dark2 = pushToContrast(brand2, WHITE, DARK_BG, MIN_UI_CONTRAST);

	return [
		`--brand:${toHex(brand)}`,
		`--brand-2:${toHex(brand2)}`,
		`--brand-ink:${inkFor([brand, brand2])}`,
		`--brand-dk:${toHex(dark)}`,
		`--brand-2-dk:${toHex(dark2)}`,
		`--brand-ink-dk:${inkFor([dark, dark2])}`,
		`--brand-qr:${toHex(pushToContrast(brand, BLACK, WHITE, MIN_QR_CONTRAST))}`,
		`--brand-2-qr:${toHex(pushToContrast(brand2, BLACK, WHITE, MIN_QR_CONTRAST))}`,
	].join(";");
}

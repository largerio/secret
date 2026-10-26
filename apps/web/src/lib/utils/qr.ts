/** The part of qrcode's BitMatrix this module reads. */
export interface QrModules {
	readonly size: number;
	get(row: number, col: number): number;
}

/** Everything needed to draw a QR code as round dots around rounded finders and a logo. */
export interface QrDrawing {
	/** Modules per side, quiet zone excluded. */
	readonly size: number;
	/** One SVG path holding a dot for every dark module outside the finders and the logo. */
	readonly dots: string;
	/** Top-left corner of each finder pattern, in modules. */
	readonly finders: readonly { readonly x: number; readonly y: number }[];
	/** The square left clear for the logo, in modules. */
	readonly logo: { readonly start: number; readonly size: number };
}

const FINDER = 7;
const DOT_RADIUS = 0.42;
// Share of the side given to the logo. At error-correction level H a reader
// recovers 30 % of the symbol; this square covers about 5 %.
const LOGO_RATIO = 0.22;

/**
 * Lay out a QR symbol for drawing. Finder patterns are left out of `dots` so
 * they can be drawn as rounded squares, and so is the centre square the logo
 * sits on.
 */
export function layoutQr(modules: QrModules): QrDrawing {
	const { size } = modules;
	const logoSize = Math.round(size * LOGO_RATIO) | 1;
	const logoStart = (size - logoSize) / 2;
	const far = size - FINDER;

	const inFinder = (row: number, col: number) =>
		(row < FINDER && (col < FINDER || col >= far)) || (row >= far && col < FINDER);
	const inLogo = (row: number, col: number) =>
		row >= logoStart &&
		row < logoStart + logoSize &&
		col >= logoStart &&
		col < logoStart + logoSize;

	// A circle as two arcs, drawn from its left edge.
	const r = DOT_RADIUS;
	const arcs = `a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 -${r * 2} 0`;
	let dots = "";
	for (let row = 0; row < size; row++) {
		for (let col = 0; col < size; col++) {
			if (!modules.get(row, col) || inFinder(row, col) || inLogo(row, col)) continue;
			dots += `M${(col + 0.5 - r).toFixed(2)} ${row + 0.5}${arcs}`;
		}
	}

	return {
		size,
		dots,
		finders: [
			{ x: 0, y: 0 },
			{ x: far, y: 0 },
			{ x: 0, y: far },
		],
		logo: { start: logoStart, size: logoSize },
	};
}

/**
 * Encode a link and lay it out. Level H is what lets the logo cover the
 * centre. qrcode is lazy-imported: it is only needed once a note exists.
 */
export async function drawQr(text: string): Promise<QrDrawing> {
	const { create } = await import("qrcode");
	return layoutQr(create(text, { errorCorrectionLevel: "H" }).modules);
}

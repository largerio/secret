import jsQR from "jsqr";
import { create } from "qrcode";
import { describe, expect, it } from "vitest";
import { drawQr, layoutQr, type QrDrawing, type QrModules } from "../qr.js";

/** A symbol whose every module is dark, so only the carved-out areas lack dots. */
function solid(size: number): QrModules {
	return { size, get: () => 1 };
}

function dotCount(path: string): number {
	return path.split("M").length - 1;
}

/**
 * Rasterise a symbol the way a camera would see the drawn code: modules as
 * squares, a quiet zone around, and the logo square painted solid dark like
 * the gradient plate it sits on.
 */
function rasterise(modules: QrModules, logo: QrDrawing["logo"], scale = 4, quiet = 4) {
	const width = (modules.size + quiet * 2) * scale;
	const data = new Uint8ClampedArray(width * width * 4).fill(255);
	const inLogo = (n: number) => n >= logo.start && n < logo.start + logo.size;
	for (let row = 0; row < modules.size; row++) {
		for (let col = 0; col < modules.size; col++) {
			const dark = (inLogo(row) && inLogo(col)) || modules.get(row, col);
			if (!dark) continue;
			for (let y = 0; y < scale; y++) {
				for (let x = 0; x < scale; x++) {
					const i = (((row + quiet) * scale + y) * width + (col + quiet) * scale + x) * 4;
					data.fill(0, i, i + 3);
				}
			}
		}
	}
	return { data, width };
}

describe("layoutQr", () => {
	it("places the three finders in their corners", () => {
		expect(layoutQr(solid(25)).finders).toEqual([
			{ x: 0, y: 0 },
			{ x: 18, y: 0 },
			{ x: 0, y: 18 },
		]);
	});

	it("centres an odd-sized square for the logo", () => {
		const { logo } = layoutQr(solid(25));
		expect(logo).toEqual({ start: 9, size: 7 });
		expect(logo.size % 2).toBe(1);
	});

	it("draws one dot per dark module outside the finders and the logo", () => {
		const drawing = layoutQr(solid(25));
		expect(dotCount(drawing.dots)).toBe(25 * 25 - 3 * 7 * 7 - 7 * 7);
	});

	it("skips light modules", () => {
		const drawing = layoutQr({ size: 21, get: () => 0 });
		expect(drawing.dots).toBe("");
	});

	it("writes each dot as a circle at its module's centre", () => {
		const onlyOne: QrModules = { size: 25, get: (row, col) => (row === 8 && col === 20 ? 1 : 0) };
		expect(layoutQr(onlyOne).dots).toBe(
			"M20.08 8.5a0.42 0.42 0 1 0 0.84 0a0.42 0.42 0 1 0 -0.84 0",
		);
	});
});

describe("drawQr", () => {
	it.each([
		"https://s.io/note/abc#k7Qm2xLp9vT4nB8rWc3yZ1hF6sJ0dGa5eU_-Ab12Cd3",
		"https://secret.example.com/note/V1StGXR8_Z5jdHi6B#k7Qm2xLp9vT4nB8rWc3yZ1hF6sJ0dGa5eU_-Ab12Cd3",
	])("stays readable with the logo over its centre: %s", (link) => {
		const { modules } = create(link, { errorCorrectionLevel: "H" });
		const { data, width } = rasterise(modules, layoutQr(modules).logo);
		expect(jsQR(data, width, width)?.data).toBe(link);
	});

	it("encodes at level H so the logo square stays recoverable", async () => {
		const link =
			"https://secret.example.com/note/V1StGXR8_Z5jdHi6B#k7Qm2xLp9vT4nB8rWc3yZ1hF6sJ0dGa5eU";
		const drawing = await drawQr(link);
		const reference = create(link, { errorCorrectionLevel: "H" }).modules;

		expect(drawing.size).toBe(reference.size);
		expect(drawing.dots).toBe(layoutQr(reference).dots);
	});
});

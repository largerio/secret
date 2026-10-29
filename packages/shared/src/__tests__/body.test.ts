import { describe, expect, it } from "vitest";
import { BODY_FLOOR, isSizeClass, sizeClass } from "../body.js";
import { testVectors } from "../test-vectors/index.js";

describe("sizeClass", () => {
	it("pads every body up to the floor to the floor", () => {
		for (const length of [0, 1, 40, 4095, BODY_FLOOR]) {
			expect(sizeClass(length)).toBe(BODY_FLOOR);
		}
	});

	it.each([
		// E = 12, S = 4: steps of 2^8.
		[4097, 4352],
		[4352, 4352],
		[4353, 4608],
		// E = 15, S = 4, then E = 16, S = 5: the step stays 2^11 across 65,536.
		[32_769, 34_816],
		[65_535, 65_536],
		[65_537, 67_584],
		[1_000_000, 1_015_808],
		[524_288_000, 528_482_304],
	])("pads %i bytes to %i", (length, padded) => {
		expect(sizeClass(length)).toBe(padded);
	});

	it("stays exact where a floating-point log2 rounds up", () => {
		// Math.log2(2 ** 53 - 1) is 53: E must be 52 here.
		expect(sizeClass(2 ** 53 - 1)).toBe(2 ** 53);
		expect(sizeClass(2 ** 40 - 1)).toBe(2 ** 40);
		expect(sizeClass(2 ** 40 + 1)).toBe(2 ** 40 + 2 ** 34);
	});

	it("adds at most 6.25%, and 3.125% from 65,536 bytes on", () => {
		for (let length = BODY_FLOOR + 1; length < 1 << 22; length += 997) {
			const overhead = (sizeClass(length) - length) / length;
			expect(overhead).toBeLessThan(length < 65_536 ? 0.0625 : 0.03125);
		}
	});

	it.each([-1, 1.5, Number.NaN, 2 ** 53])("refuses %s", (length) => {
		expect(() => sizeClass(length)).toThrow(RangeError);
	});
});

describe("isSizeClass", () => {
	it("holds for every size class, and for nothing else", () => {
		const classes = new Set<number>();
		for (let length = 0; length <= 1 << 17; length++) {
			classes.add(sizeClass(length));
		}
		for (let length = 0; length <= 1 << 17; length++) {
			expect(isSizeClass(length), String(length)).toBe(classes.has(length));
		}
	});

	it.each([-4096, 4096.5, Number.POSITIVE_INFINITY])("is false for %s", (length) => {
		expect(isSizeClass(length)).toBe(false);
	});
});

describe("the size class vectors", () => {
	it("match", () => {
		for (const v of testVectors.vectors.format1.sizeClasses) {
			expect(sizeClass(v.length), String(v.length)).toBe(v.sizeClass);
			expect(isSizeClass(v.sizeClass)).toBe(true);
		}
	});
});

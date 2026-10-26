import { describe, expect, it } from "vitest";
import { formatSize } from "../format.js";

// Intl separates number and unit with a (narrow) no-break space; compare with plain ones.
const size = (bytes: number, locale?: string) =>
	formatSize(bytes, locale).replace(/[\u00a0\u202f]/g, " ");

describe("formatSize", () => {
	it("formats counts below 1 KiB as bytes", () => {
		expect(size(0)).toBe("0 byte");
		expect(size(1023)).toBe("1,023 byte");
	});

	it("switches to kilobytes at 1 KiB, with at most one decimal", () => {
		expect(size(1024)).toBe("1 kB");
		expect(size(1536)).toBe("1.5 kB");
	});

	it("switches to megabytes at 1 MiB", () => {
		expect(size(1024 * 1024)).toBe("1 MB");
		expect(size(Math.round(29.6 * 1024 * 1024))).toBe("29.6 MB");
	});

	it("speaks the reader's language", () => {
		expect(size(Math.round(2.5 * 1024 * 1024), "fr")).toBe("2,5 Mo");
		expect(size(1536, "ru")).toBe("1,5 кБ");
	});
});

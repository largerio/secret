import { describe, expect, it } from "vitest";
import { formatSize } from "../format.js";

describe("formatSize", () => {
	it("formats bytes below 1 KiB as bytes", () => {
		expect(formatSize(0)).toBe("0 B");
		expect(formatSize(512)).toBe("512 B");
		expect(formatSize(1023)).toBe("1023 B");
	});

	it("formats the 1 KiB boundary as kilobytes", () => {
		expect(formatSize(1024)).toBe("1.0 KB");
	});

	it("formats values below 1 MiB as kilobytes with one decimal", () => {
		expect(formatSize(1536)).toBe("1.5 KB");
		expect(formatSize(1024 * 1024 - 1)).toBe("1024.0 KB");
	});

	it("formats the 1 MiB boundary as megabytes", () => {
		expect(formatSize(1024 * 1024)).toBe("1.0 MB");
	});

	it("formats large values as megabytes with one decimal", () => {
		expect(formatSize(5 * 1024 * 1024)).toBe("5.0 MB");
		expect(formatSize(Math.round(2.5 * 1024 * 1024))).toBe("2.5 MB");
	});
});

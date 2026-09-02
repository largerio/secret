import { describe, expect, it } from "vitest";
import { UsageError } from "../errors.js";
import { formatBytes, mimeType, parseDuration, parseReads, safeFilename } from "../format.js";

describe("parseDuration", () => {
	it("reads bare seconds", () => {
		expect(parseDuration("3600")).toBe(3600);
	});

	it("reads s, m, h and d suffixes, case-insensitively", () => {
		expect(parseDuration("45s")).toBe(45);
		expect(parseDuration("30m")).toBe(1800);
		expect(parseDuration("2h")).toBe(7200);
		expect(parseDuration("7D")).toBe(604_800);
	});

	it("tolerates surrounding whitespace", () => {
		expect(parseDuration(" 5m ")).toBe(300);
	});

	it.each(["", "abc", "1.5h", "-3", "10x", "h"])("rejects '%s'", (input) => {
		expect(() => parseDuration(input)).toThrow(UsageError);
		expect(() => parseDuration(input)).toThrow(/Invalid duration/);
	});
});

describe("parseReads", () => {
	it("reads a whole number, 0 included", () => {
		expect(parseReads("0")).toBe(0);
		expect(parseReads(" 12 ")).toBe(12);
	});

	it.each(["", "-1", "1.5", "many"])("rejects '%s'", (input) => {
		expect(() => parseReads(input)).toThrow(UsageError);
	});
});

describe("formatBytes", () => {
	it("picks the unit", () => {
		expect(formatBytes(0)).toBe("0 B");
		expect(formatBytes(1023)).toBe("1023 B");
		expect(formatBytes(1024)).toBe("1.0 KB");
		expect(formatBytes(1_500_000)).toBe("1.4 MB");
		expect(formatBytes(3 * 1024 ** 3)).toBe("3.0 GB");
		expect(formatBytes(5 * 1024 ** 4)).toBe("5120.0 GB");
	});
});

describe("mimeType", () => {
	it("maps known extensions, case-insensitively", () => {
		expect(mimeType("report.PDF")).toBe("application/pdf");
		expect(mimeType("photo.jpeg")).toBe("image/jpeg");
		expect(mimeType("notes.md")).toBe("text/markdown");
	});

	it("falls back to an opaque type", () => {
		expect(mimeType("archive.xyz")).toBe("application/octet-stream");
		expect(mimeType("Makefile")).toBe("application/octet-stream");
	});
});

describe("safeFilename", () => {
	it("keeps a plain name", () => {
		expect(safeFilename("report.pdf")).toBe("report.pdf");
	});

	it("drops directories, including traversal and Windows separators", () => {
		expect(safeFilename("../../.ssh/authorized_keys")).toBe("authorized_keys");
		expect(safeFilename("C:\\Users\\me\\notes.txt")).toBe("notes.txt");
	});

	it.each(["", ".", "..", "/"])("substitutes a name for '%s'", (input) => {
		expect(safeFilename(input)).toBe("file");
	});
});

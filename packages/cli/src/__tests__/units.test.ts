import { describe, expect, it } from "vitest";
import { DEFAULT_TYPE, mimeTypeOf } from "../mime.js";
import { formatDuration, formatSize, parseDuration } from "../units.js";

describe("parseDuration", () => {
	it.each([
		["90s", 90],
		["30m", 1800],
		["1h", 3600],
		["7d", 604_800],
		["2w", 1_209_600],
		["3600", 3600],
	])("reads %s as %d seconds", (value, seconds) => {
		expect(parseDuration(value)).toBe(seconds);
	});

	it.each(["", "1x", "-1h", "1.5h", "1h30m", " 1h", "1H", "1234567890"])("refuses %j", (value) => {
		expect(parseDuration(value)).toBeUndefined();
	});
});

describe("formatDuration", () => {
	it.each([
		[0, "0s"],
		[45, "45s"],
		[300, "5m"],
		[3600, "1h"],
		[5400, "1h 30m"],
		[86_400, "1d"],
		[90_061, "1d 1h"],
		[2_592_000, "30d"],
		[-5, "0s"],
	])("shows %d seconds as %s", (seconds, text) => {
		expect(formatDuration(seconds)).toBe(text);
	});
});

describe("formatSize", () => {
	it.each([
		[0, "0 B"],
		[1023, "1023 B"],
		[1536, "1.5 KiB"],
		[20 * 1024, "20 KiB"],
		[5 * 1024 ** 2, "5.0 MiB"],
		[3 * 1024 ** 3, "3.0 GiB"],
		[2048 * 1024 ** 4, "2048 TiB"],
	])("shows %d bytes as %s", (bytes, text) => {
		expect(formatSize(bytes)).toBe(text);
	});
});

describe("mimeTypeOf", () => {
	it("goes by the extension, whatever its case", () => {
		expect(mimeTypeOf("report.PDF")).toBe("application/pdf");
		expect(mimeTypeOf("/tmp/photo.jpeg")).toBe("image/jpeg");
		expect(mimeTypeOf("backup.tar.gz")).toBe("application/gzip");
	});

	it("sends anything else as bytes", () => {
		expect(mimeTypeOf("Makefile")).toBe(DEFAULT_TYPE);
		expect(mimeTypeOf(".env")).toBe(DEFAULT_TYPE);
		expect(mimeTypeOf("program.exe")).toBe(DEFAULT_TYPE);
	});
});

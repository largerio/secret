import {
	DEFAULT_CHUNK_SIZE,
	EXPIRATION_OPTIONS,
	MAX_EXPIRY_SECONDS,
	MAX_FILE_SIZE,
} from "@largerio/secret-shared";
import { describe, expect, it } from "vitest";
import {
	allowedExpirationOptions,
	buildServerConfig,
	defaultExpiration,
	readPositiveInt,
} from "../server-config.js";

describe("readPositiveInt", () => {
	it("reads a valid value", () => {
		expect(readPositiveInt("2048", 99)).toBe(2048);
	});

	it.each([
		["undefined", undefined],
		["empty", ""],
		["whitespace", "   "],
		["a size suffix", "20MB"],
		["not a number", "lots"],
		["zero", "0"],
		["negative", "-1"],
		["infinity", "Infinity"],
	])("falls back on %s", (_label, value) => {
		// "20MB" produced NaN, and `file.size > NaN` is always false — size
		// validation silently stopped happening. "" produced 0, which rejected
		// every non-empty file instead.
		expect(readPositiveInt(value, 99)).toBe(99);
	});

	it("truncates a fractional value rather than propagating it", () => {
		expect(readPositiveInt("10.9", 99)).toBe(10);
	});
});

describe("buildServerConfig", () => {
	it("falls back to defaults on an empty environment", () => {
		const config = buildServerConfig({}, "https://secret.example.com");

		expect(config.appUrl).toBe("https://secret.example.com");
		expect(config.maxFileSize).toBe(MAX_FILE_SIZE);
		expect(config.chunkSize).toBe(DEFAULT_CHUNK_SIZE);
		expect(config.maxExpiry).toBe(MAX_EXPIRY_SECONDS);
		expect(config.ogImageUrl).toBe("https://secret.example.com/og.png");
	});

	it("prefers APP_URL over the request origin", () => {
		const config = buildServerConfig(
			{ APP_URL: "https://pinned.example" },
			"http://localhost:3000",
		);

		expect(config.appUrl).toBe("https://pinned.example");
		expect(config.ogImageUrl).toBe("https://pinned.example/og.png");
	});

	it("keeps an explicit og image", () => {
		const config = buildServerConfig(
			{ APP_OG_IMAGE_URL: "https://cdn.example/x.png" },
			"https://a.b",
		);
		expect(config.ogImageUrl).toBe("https://cdn.example/x.png");
	});

	it("carries a tightened retention ceiling through", () => {
		expect(buildServerConfig({ MAX_EXPIRY: "3600" }, "https://a.b").maxExpiry).toBe(3600);
	});

	it("ignores an unusable limit instead of disabling validation", () => {
		const config = buildServerConfig(
			{ MAX_FILE_SIZE: "20MB", MAX_FILES_PER_NOTE: "" },
			"https://a.b",
		);

		expect(config.maxFileSize).toBe(MAX_FILE_SIZE);
		expect(Number.isFinite(config.maxFilesPerNote)).toBe(true);
	});
});

describe("allowedExpirationOptions", () => {
	it("lists every option when the ceiling is the protocol maximum", () => {
		expect(allowedExpirationOptions(MAX_EXPIRY_SECONDS)).toHaveLength(EXPIRATION_OPTIONS.length);
	});

	it("hides options the server would reject", () => {
		// The regression this exists to prevent: an operator sets MAX_EXPIRY to
		// 7 days, the picker keeps offering "30 days", and choosing it fails with
		// a raw 400 from the API.
		const options = allowedExpirationOptions(604_800);

		expect(options.map((o) => o.value)).toEqual([300, 3600, 86_400, 604_800]);
		expect(options.some((o) => o.value === 2_592_000)).toBe(false);
	});

	it("never returns an empty picker", () => {
		// Below even the shortest option, offering it and letting the server
		// reject it beats rendering a select with no choices.
		expect(allowedExpirationOptions(60)).toHaveLength(1);
		expect(allowedExpirationOptions(60)[0]?.value).toBe(300);
	});
});

describe("defaultExpiration", () => {
	it("keeps the 24h default when it fits", () => {
		expect(defaultExpiration(MAX_EXPIRY_SECONDS)).toBe(86_400);
		expect(defaultExpiration(86_400)).toBe(86_400);
	});

	it("falls back to the longest allowed option when the default is too long", () => {
		expect(defaultExpiration(3600)).toBe(3600);
	});

	it("returns the shortest option when the ceiling is below all of them", () => {
		expect(defaultExpiration(60)).toBe(300);
	});
});

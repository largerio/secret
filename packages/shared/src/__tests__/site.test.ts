import { describe, expect, it } from "vitest";
import {
	DEFAULT_LOCALE,
	isLocale,
	isThemePreference,
	LOCALES,
	parseAcceptLanguage,
	parseShellData,
	type ShellData,
	serializeShellData,
} from "../site.js";
import type { ServerConfig } from "../types.js";

const config: ServerConfig = {
	appName: "Secret",
	appDescription: "Zero-knowledge encrypted sharing",
	appUrl: "https://secret.example.com",
	primaryColor: "#4f46e5",
	footerText: "",
	ogImageUrl: "https://secret.example.com/og.png",
	maxFileSize: 20_971_520,
	maxFilesPerNote: 10,
	chunkSize: 4_194_304,
	maxChunkedFileSize: 524_288_000,
	maxExpiry: 2_592_000,
};

const data: ShellData = { config, locale: "fr", theme: "dark" };

describe("parseAcceptLanguage", () => {
	it("picks the first supported language", () => {
		expect(parseAcceptLanguage("fr-FR,fr;q=0.9,en;q=0.8")).toBe("fr");
	});

	it("respects quality weighting over order", () => {
		expect(parseAcceptLanguage("en;q=0.5,de;q=0.9")).toBe("de");
	});

	it("falls back to English for unsupported or empty headers", () => {
		expect(parseAcceptLanguage("xx-YY,zz")).toBe("en");
		expect(parseAcceptLanguage("")).toBe(DEFAULT_LOCALE);
	});
});

describe("isLocale and isThemePreference", () => {
	it("accept what the web app speaks and offers, nothing else", () => {
		for (const locale of LOCALES) {
			expect(isLocale(locale)).toBe(true);
		}
		expect(isLocale("xx")).toBe(false);
		expect(isLocale(1)).toBe(false);

		for (const theme of ["light", "dark", "system"]) {
			expect(isThemePreference(theme)).toBe(true);
		}
		expect(isThemePreference("blue")).toBe(false);
	});
});

describe("serializeShellData", () => {
	it("round-trips through parseShellData", () => {
		expect(parseShellData(serializeShellData(data))).toEqual(data);
	});

	it("leaves nothing that could close the element or start markup", () => {
		const hostile: ShellData = {
			...data,
			config: { ...config, appName: "</script><script>alert(1)</script>&amp;\u2028\u2029" },
		};

		const text = serializeShellData(hostile);

		expect(text).not.toMatch(/[<>&\u2028\u2029]/);
		expect(parseShellData(text)).toEqual(hostile);
	});
});

describe("parseShellData", () => {
	it("is undefined for a page without shell data", () => {
		expect(parseShellData(null)).toBeUndefined();
		expect(parseShellData(undefined)).toBeUndefined();
		expect(parseShellData("")).toBeUndefined();
	});

	it("is undefined for text that is not JSON, or not an object", () => {
		expect(parseShellData("{")).toBeUndefined();
		expect(parseShellData("[]")).toBeUndefined();
		expect(parseShellData("null")).toBeUndefined();
	});

	it("is undefined for a config that misses or mistypes a setting", () => {
		const { appName: _, ...withoutName } = config;
		const cases: ReadonlyArray<unknown> = [
			undefined,
			"config",
			withoutName,
			{ ...config, maxFileSize: "20MB" },
			{ ...config, chunkSize: 0 },
			{ ...config, maxExpiry: 1.5 },
		];

		for (const candidate of cases) {
			expect(parseShellData(JSON.stringify({ ...data, config: candidate }))).toBeUndefined();
		}
	});

	it("is undefined for a locale or a theme it does not know", () => {
		expect(parseShellData(JSON.stringify({ ...data, locale: "xx" }))).toBeUndefined();
		expect(parseShellData(JSON.stringify({ ...data, theme: "blue" }))).toBeUndefined();
	});

	it("keeps only the shell data's fields", () => {
		const parsed = parseShellData(JSON.stringify({ ...data, extra: true }));

		expect(parsed).toEqual(data);
	});
});

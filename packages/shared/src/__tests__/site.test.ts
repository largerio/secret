import { describe, expect, it } from "vitest";
import {
	DEFAULT_LOCALE,
	errorTitle,
	headerQualities,
	INSTANCE_LIMITS,
	isInstanceLimit,
	isLocale,
	isThemePreference,
	LOCALES,
	missingShellMarkers,
	type PageConfig,
	pageTitle,
	parseAcceptLanguage,
	parseShellData,
	SHELL_HEAD_MARKER,
	SHELL_HTML_TAG,
	type ShellData,
	serializeShellData,
	type TitleKey,
	themePreferenceOf,
} from "../site.js";

const config: PageConfig = {
	appName: "Secret",
	footerText: "",
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

	it("never picks a language given q=0, or a q that is no number", () => {
		expect(parseAcceptLanguage("fr;q=0,de;q=0.1")).toBe("de");
		expect(parseAcceptLanguage("fr;q=high,es;q=0.2")).toBe("es");
		expect(parseAcceptLanguage("fr;q=0")).toBe(DEFAULT_LOCALE);
	});

	it("reads a q written with spaces, and keeps the header's order between equals", () => {
		expect(parseAcceptLanguage("fr ; q = 0.5, de;q=0.9")).toBe("de");
		expect(parseAcceptLanguage("ja;q=0.8, ko;q=0.8")).toBe("ja");
	});
});

describe("headerQualities", () => {
	it("gives each name its q, 1 without one and 0 for one that is no number", () => {
		expect(headerQualities("BR;q=0.5, gzip, deflate;q=, zstd;q, *;q=0")).toEqual(
			new Map([
				["br", 0.5],
				["gzip", 1],
				["deflate", 0],
				["zstd", 0],
				["*", 0],
			]),
		);
	});

	it("skips empty items", () => {
		expect(headerQualities(" , ,gzip")).toEqual(new Map([["gzip", 1]]));
	});
});

describe("missingShellMarkers", () => {
	it("names the markers a shell lacks", () => {
		expect(missingShellMarkers(`${SHELL_HTML_TAG}<head>${SHELL_HEAD_MARKER}`)).toEqual([]);
		expect(missingShellMarkers(`${SHELL_HTML_TAG}<head>`)).toEqual([SHELL_HEAD_MARKER]);
		expect(missingShellMarkers("<html>")).toEqual([SHELL_HTML_TAG, SHELL_HEAD_MARKER]);
	});
});

describe("isInstanceLimit", () => {
	it("accepts a whole number above zero, exact as a double", () => {
		expect(isInstanceLimit(1)).toBe(true);
		expect(isInstanceLimit(Number.MAX_SAFE_INTEGER)).toBe(true);
		for (const value of [0, -1, 1.5, 2 ** 53, Number.NaN, "10", null]) {
			expect(isInstanceLimit(value)).toBe(false);
		}
	});
});

describe("themePreferenceOf", () => {
	it("keeps a theme the app offers, and makes anything else the system's", () => {
		expect(themePreferenceOf("dark")).toBe("dark");
		expect(themePreferenceOf("light")).toBe("light");
		expect(themePreferenceOf("blue")).toBe("system");
		expect(themePreferenceOf(undefined)).toBe("system");
	});
});

describe("pageTitle", () => {
	const messages: Record<TitleKey, string> = {
		seo_title: "{app} — share secrets, {app} keeps none",
		view_title: "A note",
		manage_title: "Delete",
	};
	const t = (key: TitleKey) => messages[key];

	it("titles each page from its message and the instance's name", () => {
		expect(pageTitle("home", "Vault", t)).toBe("Vault — share secrets, Vault keeps none");
		expect(pageTitle("note", "Vault", t)).toBe("Vault — A note");
		expect(pageTitle("manage", "Vault", t)).toBe("Vault — Delete");
		expect(pageTitle("notFound", "Vault", t)).toBe("404 | Vault");
	});

	it("writes a name with $ as it is", () => {
		expect(pageTitle("home", "$&$1", t)).toBe("$&$1 — share secrets, $&$1 keeps none");
	});
});

describe("errorTitle", () => {
	it("puts the status before the instance's name", () => {
		expect(errorTitle(500, "Vault")).toBe("500 | Vault");
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
			{ ...config, footerText: null },
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

	it("keeps only the shell data's fields, and the settings a page reads", () => {
		const parsed = parseShellData(
			JSON.stringify({ ...data, extra: true, config: { ...config, appUrl: "https://x" } }),
		);

		expect(parsed).toEqual(data);
	});

	it("reads every instance limit", () => {
		const parsed = parseShellData(serializeShellData(data));

		for (const key of INSTANCE_LIMITS) {
			expect(parsed?.config[key]).toBe(config[key]);
		}
	});
});

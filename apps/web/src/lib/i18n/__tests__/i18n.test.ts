import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
	detectLocale,
	formatDateTime,
	getLocale,
	type Locale,
	type MessageKey,
	parseAcceptLanguage,
	setLocale,
	t,
} from "../index.svelte.js";

afterEach(() => {
	vi.unstubAllGlobals();
	setLocale("en");
});

describe("parseAcceptLanguage", () => {
	it("picks the first supported language", () => {
		expect(parseAcceptLanguage("fr-FR,fr;q=0.9,en;q=0.8")).toBe("fr");
	});

	it("respects quality weighting over order", () => {
		expect(parseAcceptLanguage("en;q=0.5,de;q=0.9")).toBe("de");
	});

	it("falls back to English for unsupported or empty headers", () => {
		expect(parseAcceptLanguage("xx-YY,zz")).toBe("en");
		expect(parseAcceptLanguage("")).toBe("en");
	});
});

describe("locale state and translation", () => {
	afterAll(() => {
		setLocale("en");
	});

	it("round-trips the active locale", () => {
		setLocale("fr");
		expect(getLocale()).toBe("fr");
		setLocale("en");
		expect(getLocale()).toBe("en");
	});

	it("interpolates named parameters", () => {
		// `chunk_progress` is defined as "Chunk {current} of {total}".
		setLocale("en");
		expect(t("chunk_progress", { current: 2, total: 5 })).toBe("Chunk 2 of 5");
	});

	it("returns the key unchanged for an unknown message", () => {
		expect(t("totally_made_up_key" as MessageKey)).toBe("totally_made_up_key");
	});

	it("falls back to the English message when the active locale has no map", () => {
		setLocale("xx" as Locale);
		expect(t("chunk_progress", { current: 1, total: 2 })).toBe("Chunk 1 of 2");
	});

	it("returns the raw message when no params are supplied", () => {
		const value = t("chunk_progress");
		expect(value).toContain("{current}");
		expect(value).toContain("{total}");
	});
});

describe("detectLocale", () => {
	it("returns a supported locale based on navigator.language", () => {
		// jsdom reports navigator.language as "en-US".
		expect(detectLocale()).toBe("en");
	});

	it("returns English when navigator is unavailable (SSR)", () => {
		vi.stubGlobal("navigator", undefined);
		expect(detectLocale()).toBe("en");
	});

	it("returns English when navigator.language is unsupported", () => {
		vi.stubGlobal("navigator", { language: "xx-XX" });
		expect(detectLocale()).toBe("en");
	});

	it("maps a supported navigator.language to its locale", () => {
		vi.stubGlobal("navigator", { language: "fr-FR" });
		expect(detectLocale()).toBe("fr");
	});
});

describe("formatDateTime", () => {
	it("formats a timestamp into a localized, non-empty string", () => {
		setLocale("en");
		const formatted = formatDateTime("2026-06-04T12:00:00Z");
		expect(typeof formatted).toBe("string");
		expect(formatted).toContain("2026");
		setLocale("en");
	});
});

import { LOCALE_COOKIE, pageTitle } from "@largerio/secret-shared/site";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import de from "../../../../../../messages/de.json";
import en from "../../../../../../messages/en.json";
import fr from "../../../../../../messages/fr.json";
import { setPreferenceCookie } from "../../utils/cookies.js";
import {
	detectLocale,
	formatDateTime,
	getLocale,
	type Locale,
	type MessageKey,
	setLocale,
	t,
	tn,
} from "../index.svelte.js";
import { loadMessages, serveMessages } from "./messages.js";

beforeAll(async () => {
	await loadMessages("fr", "ru");
});

afterEach(() => {
	vi.unstubAllGlobals();
	setLocale("en");
	// The cookie chooseLocale writes, cleared as the app writes it.
	setPreferenceCookie(LOCALE_COOKIE, "", 0);
});

/** The module as a page starts with it: English alone, nothing loaded or chosen yet. */
async function freshI18n() {
	vi.resetModules();
	return import("../index.svelte.js");
}

/** A fetch of the messages that answers when the test says, language by language. */
function heldFetch() {
	const held = new Map<string, { url: string; answer: (response: Response) => void }>();
	const fetcher = vi.fn<typeof fetch>(
		(input) =>
			new Promise((answer) => {
				const url = String(input);
				held.set(url.slice(url.lastIndexOf("/") + 1, -".json".length), { url, answer });
			}),
	);
	vi.stubGlobal("fetch", fetcher);
	return {
		fetcher,
		/** Answers the fetch of a language's file: with the file, or with `response`. */
		async answer(locale: Locale, response?: Response) {
			const request = held.get(locale);
			if (request === undefined) throw new Error(`${locale} was not fetched`);
			request.answer(response ?? (await serveMessages(request.url)));
		},
	};
}

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

	it("keeps <html lang> in step with the page's language", () => {
		setLocale("ja");
		expect(document.documentElement.lang).toBe("ja");
		setLocale("en");
		expect(document.documentElement.lang).toBe("en");
	});

	it("speaks a language once its messages are loaded", () => {
		setLocale("fr");
		expect(t("lang_label")).toBe(fr.lang_label);
		expect(t("lang_label")).not.toBe(en.lang_label);
	});

	it("speaks English in a language whose messages are not loaded", () => {
		setLocale("de");
		expect(t("lang_label")).toBe(en.lang_label);
	});

	it("interpolates named parameters", () => {
		// `chunk_progress` is defined as "Chunk {current} of {total}".
		setLocale("en");
		expect(t("chunk_progress", { current: 2, total: 5 })).toBe("Part 2 of 5");
	});

	it("returns the key unchanged for an unknown message", () => {
		expect(t("totally_made_up_key" as MessageKey)).toBe("totally_made_up_key");
	});

	it("falls back to the English message when the active locale has no map", () => {
		setLocale("xx" as Locale);
		expect(t("chunk_progress", { current: 1, total: 2 })).toBe("Part 1 of 2");
	});

	it("returns the raw message when no params are supplied", () => {
		const value = t("chunk_progress");
		expect(value).toContain("{current}");
		expect(value).toContain("{total}");
	});

	it("gives the shared page titles what they expect, {app} left in", () => {
		// The pages and the server build their titles with pageTitle alike.
		expect(pageTitle("home", "Vault", t)).toBe(
			"Vault — Secure, Zero-Knowledge Encrypted Note & File Sharing",
		);
		setLocale("fr");
		expect(pageTitle("manage", "Vault", t)).toBe(`Vault — ${t("manage_title")}`);
	});
});

describe("loadLocale", () => {
	it("needs nothing for English, which the bundle carries", async () => {
		const i18n = await freshI18n();
		const fetcher = vi.fn(serveMessages);
		vi.stubGlobal("fetch", fetcher);

		await i18n.loadLocale("en");

		expect(fetcher).not.toHaveBeenCalled();
	});

	it("fetches a language's file once, however often it is asked for", async () => {
		const i18n = await freshI18n();
		const fetcher = vi.fn(serveMessages);
		vi.stubGlobal("fetch", fetcher);

		await Promise.all([i18n.loadLocale("fr"), i18n.loadLocale("fr")]);
		await i18n.loadLocale("fr");

		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(fetcher).toHaveBeenCalledWith(expect.stringMatching(/\/messages\/fr\.json$/));
		i18n.setLocale("fr");
		expect(i18n.t("lang_label")).toBe(fr.lang_label);
	});

	it("keeps only the texts of the file, English filling in", async () => {
		const i18n = await freshI18n();
		const body = { lang_label: "Sprache!", chunk_progress: 3, missing: null };
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json(body)),
		);

		await i18n.loadLocale("de");
		i18n.setLocale("de");

		expect(i18n.t("lang_label")).toBe("Sprache!");
		expect(i18n.t("chunk_progress", { current: 1, total: 2 })).toBe("Part 1 of 2");
	});

	it.each(["[]", "null", '"text"', "{"])("refuses a file that holds %s", async (text) => {
		const i18n = await freshI18n();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(text)),
		);

		await expect(i18n.loadLocale("es")).rejects.toThrow();
		i18n.setLocale("es");
		expect(i18n.t("lang_label")).toBe(en.lang_label);
	});

	it("rejects when the file cannot be fetched, and fetches it again next time", async () => {
		const i18n = await freshI18n();
		const fetcher = vi
			.fn<typeof fetch>(serveMessages)
			.mockRejectedValueOnce(new TypeError("Failed to fetch"))
			.mockResolvedValueOnce(new Response(null, { status: 404 }));
		vi.stubGlobal("fetch", fetcher);

		await expect(i18n.loadLocale("ja")).rejects.toThrow("Failed to fetch");
		await expect(i18n.loadLocale("ja")).rejects.toThrow(/ja\.json answered 404$/);
		await expect(i18n.loadLocale("ja")).resolves.toBeUndefined();
		expect(fetcher).toHaveBeenCalledTimes(3);
	});

	it("refuses a language the build has no file for", async () => {
		const i18n = await freshI18n();

		await expect(i18n.loadLocale("xx" as Locale)).rejects.toThrow("No messages for xx");
	});
});

describe("chooseLocale", () => {
	it("switches the whole page once the language has loaded, and keeps the choice", async () => {
		const i18n = await freshI18n();
		const fetch = heldFetch();

		const choosing = i18n.chooseLocale("de");

		// Until then, the page keeps its language.
		expect(i18n.getLocale()).toBe("en");
		expect(i18n.t("lang_label")).toBe(en.lang_label);
		expect(document.cookie).not.toContain("secret_lang");

		await fetch.answer("de");
		await choosing;

		expect(i18n.getLocale()).toBe("de");
		expect(i18n.t("lang_label")).toBe(de.lang_label);
		expect(document.documentElement.lang).toBe("de");
		expect(document.cookie).toContain("secret_lang=de");
	});

	it("lets the last choice win, whichever loads first", async () => {
		const i18n = await freshI18n();
		const fetch = heldFetch();

		const first = i18n.chooseLocale("fr");
		const last = i18n.chooseLocale("de");
		await fetch.answer("de");
		await last;
		await fetch.answer("fr");
		await first;

		expect(i18n.getLocale()).toBe("de");
		expect(document.cookie).toContain("secret_lang=de");
	});

	it("lets the visitor go back to the page's language while another loads", async () => {
		const i18n = await freshI18n();
		const fetch = heldFetch();

		const first = i18n.chooseLocale("fr");
		await i18n.chooseLocale("en");
		await fetch.answer("fr");
		await first;

		expect(i18n.getLocale()).toBe("en");
		expect(document.cookie).not.toContain("secret_lang");
	});

	it("keeps the page's language when the one chosen cannot load", async () => {
		const i18n = await freshI18n();
		const fetch = heldFetch();

		const choosing = i18n.chooseLocale("it");
		await fetch.answer("it", new Response(null, { status: 503 }));

		await expect(choosing).rejects.toThrow(/answered 503$/);
		expect(i18n.getLocale()).toBe("en");
		expect(document.cookie).not.toContain("secret_lang");
	});

	it("says nothing of a choice that failed after another was made", async () => {
		const i18n = await freshI18n();
		const fetch = heldFetch();

		const first = i18n.chooseLocale("fr");
		const last = i18n.chooseLocale("de");
		await fetch.answer("fr", new Response(null, { status: 503 }));

		await expect(first).resolves.toBeUndefined();
		await fetch.answer("de");
		await last;
		expect(i18n.getLocale()).toBe("de");
	});

	it("writes no cookie for the language the page speaks already", async () => {
		const i18n = await freshI18n();

		await i18n.chooseLocale("en");

		expect(i18n.getLocale()).toBe("en");
		expect(document.cookie).not.toContain("secret_lang");
	});
});

describe("detectLocale", () => {
	it("returns a supported locale based on navigator.language", () => {
		// jsdom reports navigator.language as "en-US".
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

	it("takes the first of the browser's languages the app speaks", () => {
		vi.stubGlobal("navigator", { language: "nl-NL", languages: ["nl-NL", "de-DE", "fr-FR"] });
		expect(detectLocale()).toBe("de");
	});

	it("falls back on navigator.language when the list is empty", () => {
		vi.stubGlobal("navigator", { language: "ja-JP", languages: [] });
		expect(detectLocale()).toBe("ja");
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

describe("tn", () => {
	it("picks English's singular and plural", () => {
		expect(tn("reads_count", 1)).toBe("1 read");
		expect(tn("reads_count", 3)).toBe("3 reads");
	});

	it("uses every form a language has: Russian's one, few and many", () => {
		setLocale("ru");
		expect(tn("reads_count", 21)).toBe("21 прочтение");
		expect(tn("reads_count", 3)).toBe("3 прочтения");
		expect(tn("reads_count", 10)).toBe("10 прочтений");
	});

	it("falls back to the plural form for one a language does not define", () => {
		setLocale("ru");
		expect(tn("error_wrong_password_left", 3)).toContain("осталось 3");
	});

	it("passes other parameters through and writes the count the language's way", () => {
		expect(tn("files_limit", 1000, { size: "10 MB" })).toBe("Up to 1,000 files, 10 MB in total");
		setLocale("fr");
		expect(tn("files_limit", 1000, { size: "10 Mo" })).toBe(
			"Jusqu'à 1\u202f000 fichiers, 10 Mo au total",
		);
	});

	it("agrees with the count it is given, whatever the other numbers", () => {
		expect(tn("error_too_many_files", 1, { max: 10 })).toBe(
			"1 file ignored: a note holds 10 at most.",
		);
		setLocale("fr");
		expect(tn("error_too_many_files", 2, { max: 10 })).toBe(
			"2 fichiers ignorés : une note en contient 10 au plus.",
		);
		setLocale("ru");
		expect(tn("un_reads_total", 3)).toBe("Всего можно прочитать 3 раза");
		expect(tn("un_reads_total", 5)).toBe("Всего можно прочитать 5 раз");
	});

	it("survives a locale with no table, through the English fallback", () => {
		setLocale("xx" as Locale);
		expect(tn("reads_count", 3)).toBe("3 reads");
	});
});

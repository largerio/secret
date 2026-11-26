import {
	DEFAULT_LOCALE,
	LOCALE_COOKIE,
	type Locale,
	parseAcceptLanguage,
} from "@largerio/secret-shared/site";
import en from "../../../../../messages/en.json";
import { setPreferenceCookie } from "../utils/cookies.js";

export type { Locale } from "@largerio/secret-shared/site";
export type MessageKey = keyof typeof en;

/** A language's messages, key to text, `{param}` placeholders left in. */
type Catalog = Readonly<Record<string, string>>;

/**
 * Every language's messages but English's, each a file of the build
 * (`_app/immutable/assets/<locale>.<hash>.json`) that only the pages in that
 * language load: English, the default and every language's fallback, is the
 * only one the bundle's JavaScript carries. The files are covered by the
 * bundle's digest like the rest of the build, never written into the page by
 * the server. vite.config.ts never inlines them.
 */
const MESSAGE_FILES = import.meta.glob<string>(
	["../../../../../messages/*.json", "!../../../../../messages/en.json"],
	{ query: "?url", import: "default", eager: true },
);

/** The languages loaded so far, by code. */
const catalogs: Partial<Record<Locale, Catalog>> = { en };

/** The loads under way, by code: a language is fetched once, however many ask for it. */
const loading = new Map<Locale, Promise<void>>();

let currentLocale = $state<Locale>(DEFAULT_LOCALE);

/** A language's messages as the file holds them: an object, of which only the texts count. */
function catalogOf(body: unknown, url: string): Catalog {
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		throw new Error(`${url} is not a catalog of messages`);
	}
	return Object.fromEntries(
		Object.entries(body).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
	);
}

async function fetchCatalog(locale: Locale): Promise<Catalog> {
	const url = MESSAGE_FILES[`../../../../../messages/${locale}.json`];
	if (url === undefined) {
		throw new Error(`No messages for ${locale}`);
	}
	// fetch's default mode and credentials: those of the preload the server
	// writes into the page (crossorigin="anonymous"), whose response this uses.
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`${url} answered ${response.status}`);
	}
	return catalogOf(await response.json(), url);
}

/**
 * Loads a language's messages, at most once: resolved when they are there,
 * at once for English and for a language loaded already. Rejected when they
 * cannot be fetched, and fetched again on the next call.
 */
export function loadLocale(locale: Locale): Promise<void> {
	if (catalogs[locale] !== undefined) return Promise.resolve();

	let pending = loading.get(locale);
	if (pending === undefined) {
		pending = fetchCatalog(locale)
			.then((catalog) => {
				catalogs[locale] = catalog;
			})
			.finally(() => loading.delete(locale));
		loading.set(locale, pending);
	}
	return pending;
}

/**
 * The page's language, and `<html lang>`'s: this module is its one writer.
 * Its messages must be loaded (loadLocale), or the page speaks English.
 */
export function setLocale(locale: Locale): void {
	currentLocale = locale;
	// Kept in step with the page, or screen readers would announce it in the
	// previous language's voice (WCAG 3.1.1), with its hyphenation and quotes.
	document.documentElement.lang = locale;
}

/** How many choices the visitor made: a choice still loading yields to any made since. */
let choices = 0;

/**
 * The visitor's choice: once its messages are loaded, the whole page switches
 * to it at once, and so do the next ones (the cookie). Until then the page
 * keeps its language. Only the last choice counts: one made while another
 * loads supersedes it, which then neither switches the page nor fails.
 *
 * @throws when the language's messages cannot be loaded: the page keeps its own.
 */
export async function chooseLocale(locale: Locale): Promise<void> {
	const choice = ++choices;
	try {
		await loadLocale(locale);
	} catch (err) {
		if (choice === choices) throw err;
		return;
	}
	if (choice !== choices || locale === currentLocale) return;
	setLocale(locale);
	setPreferenceCookie(LOCALE_COOKIE, locale);
}

export function getLocale(): Locale {
	return currentLocale;
}

/**
 * The first of the browser's languages the app speaks, English failing any:
 * what the server reads from `Accept-Language`, which the browser builds from
 * the same list.
 */
export function detectLocale(): Locale {
	const languages = navigator.languages?.length ? navigator.languages : [navigator.language];
	return parseAcceptLanguage(languages.join(","));
}

const english: Catalog = en;

export function t(key: MessageKey, params?: Record<string, string | number>): string {
	const msg = catalogs[currentLocale]?.[key] ?? english[key] ?? key;
	if (!params) return msg;
	return Object.entries(params).reduce<string>(
		(result, [k, v]) => result.replaceAll(`{${k}}`, String(v)),
		msg,
	);
}

/** The bases of messages that come in plural forms: `reads_count` for `reads_count_one`… */
export type PluralKey = {
	[K in MessageKey]: K extends `${infer Base}_one` ? Base : never;
}[MessageKey];

const pluralRules = new Map<Locale, Intl.PluralRules>();

function pluralForm(count: number): Intl.LDMLPluralRule {
	let rules = pluralRules.get(currentLocale);
	if (!rules) {
		rules = new Intl.PluralRules(currentLocale);
		pluralRules.set(currentLocale, rules);
	}
	return rules.select(count);
}

/**
 * A message in the plural form the active language uses for `count`, which
 * fills `{count}`, written the language's way ("1,000", "1 000"). English
 * only needs `_one` and `_other`; a language with more forms adds them under
 * the same base (Russian's `_few` and `_many`), and any form a language does
 * not define falls back to its `_other`.
 */
export function tn(
	base: PluralKey,
	count: number,
	params?: Record<string, string | number>,
): string {
	const form = `${base}_${pluralForm(count)}`;
	const key = form in (catalogs[currentLocale] ?? {}) ? form : `${base}_other`;
	return t(key as MessageKey, { ...params, count: count.toLocaleString(currentLocale) });
}

export function formatDateTime(value: Date | number | string): string {
	return new Date(value).toLocaleString(currentLocale, {
		dateStyle: "medium",
		timeStyle: "short",
	});
}

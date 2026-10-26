import de from "../../../../../messages/de.json";
import en from "../../../../../messages/en.json";
import es from "../../../../../messages/es.json";
import fr from "../../../../../messages/fr.json";
import it from "../../../../../messages/it.json";
import ja from "../../../../../messages/ja.json";
import ko from "../../../../../messages/ko.json";
import pt from "../../../../../messages/pt.json";
import ru from "../../../../../messages/ru.json";
import zh from "../../../../../messages/zh.json";

export type Locale = "en" | "fr" | "es" | "de" | "pt" | "it" | "ja" | "zh" | "ru" | "ko";
export type MessageKey = keyof typeof en;

const messages: Record<Locale, Record<string, string>> = {
	en,
	fr,
	es,
	de,
	pt,
	it,
	ja,
	zh,
	ru,
	ko,
};

const supportedLocales = new Set<string>(Object.keys(messages));

let currentLocale = $state<Locale>("en");

export function setLocale(locale: Locale): void {
	currentLocale = locale;
}

export function getLocale(): Locale {
	return currentLocale;
}

export function parseAcceptLanguage(header: string): Locale {
	const langs = header
		.split(",")
		.map((part) => {
			const [lang = "", q] = part.trim().split(";q=");
			return { lang: lang.slice(0, 2).toLowerCase(), q: q ? Number(q) : 1 };
		})
		.sort((a, b) => b.q - a.q);

	for (const { lang } of langs) {
		if (supportedLocales.has(lang)) return lang as Locale;
	}
	return "en";
}

export function detectLocale(): Locale {
	if (typeof navigator === "undefined") return "en";
	const lang = navigator.language.slice(0, 2).toLowerCase();
	return supportedLocales.has(lang) ? (lang as Locale) : "en";
}

export function t(key: MessageKey, params?: Record<string, string | number>): string {
	const msg = messages[currentLocale]?.[key] ?? messages.en?.[key] ?? key;
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
	const key = form in (messages[currentLocale] ?? {}) ? form : `${base}_other`;
	return t(key as MessageKey, { ...params, count: count.toLocaleString(currentLocale) });
}

export function formatDateTime(value: Date | number | string): string {
	return new Date(value).toLocaleString(currentLocale, {
		dateStyle: "medium",
		timeStyle: "short",
	});
}

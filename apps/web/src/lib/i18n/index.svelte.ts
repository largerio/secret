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

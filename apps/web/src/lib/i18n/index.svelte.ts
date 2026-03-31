import en from "../../../../../messages/en.json";

export type Locale = "en" | "fr";
export type MessageKey = keyof typeof en;

const messages: Record<Locale, Record<string, string>> = { en, fr: en };
let localeLoaded = false;

let currentLocale = $state<Locale>("en");

async function loadFrench(): Promise<void> {
	if (localeLoaded) return;
	const fr = await import("../../../../../messages/fr.json");
	messages.fr = fr.default;
	localeLoaded = true;
}

export function setLocale(locale: Locale): void {
	currentLocale = locale;
	if (locale === "fr") {
		void loadFrench();
	}
}

export function getLocale(): Locale {
	return currentLocale;
}

export function detectLocale(): Locale {
	if (typeof navigator === "undefined") return "en";
	const lang = navigator.language.slice(0, 2).toLowerCase();
	return lang === "fr" ? "fr" : "en";
}

export function t(key: MessageKey, params?: Record<string, string | number>): string {
	const msg = messages[currentLocale]?.[key] ?? messages.en?.[key] ?? key;
	if (!params) return msg;
	return Object.entries(params).reduce<string>(
		(result, [k, v]) => result.replace(`{${k}}`, String(v)),
		msg,
	);
}

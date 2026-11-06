import type { ServerConfig } from "./types.js";

/**
 * What the server and the web app agree on for a page: the web app is a static
 * bundle, and the server writes into its one HTML document (`index.html`, the
 * shell) what the visitor's page starts from.
 */

/** The languages the web app speaks, its default first. */
export const LOCALES = ["en", "fr", "es", "de", "pt", "it", "ja", "zh", "ru", "ko"] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

/** What the visitor chose: "system" until they pick a theme themselves. */
export type ThemePreference = "light" | "dark" | "system";

/** First-party cookies the web app writes, and the server reads to render the shell. */
export const LOCALE_COOKIE = "secret_lang";
export const THEME_COOKIE = "secret_theme";

/**
 * The opening tag of the shell, as `apps/web/src/app.html` writes it: the
 * server replaces it with the visitor's language, theme and accent.
 */
export const SHELL_HTML_TAG = '<html lang="en" data-mode="system">';

/**
 * Where the shell's head takes what the server writes: the page's title and
 * meta tags, and the shell data.
 */
export const SHELL_HEAD_MARKER = "<!--secret:head-->";

/** The id of `<script type="application/json">` that carries the shell data. */
export const SHELL_DATA_ID = "secret-shell";

/** What the page starts from: the instance's settings and the visitor's choices. */
export interface ShellData {
	readonly config: ServerConfig;
	readonly locale: Locale;
	readonly theme: ThemePreference;
}

const localeSet = new Set<string>(LOCALES);

export function isLocale(value: unknown): value is Locale {
	return typeof value === "string" && localeSet.has(value);
}

export function isThemePreference(value: unknown): value is ThemePreference {
	return value === "light" || value === "dark" || value === "system";
}

/** The best supported language of an `Accept-Language` header, English failing any. */
export function parseAcceptLanguage(header: string): Locale {
	const langs = header
		.split(",")
		.map((part) => {
			const [lang = "", q] = part.trim().split(";q=");
			return { lang: lang.slice(0, 2).toLowerCase(), q: q ? Number(q) : 1 };
		})
		.sort((a, b) => b.q - a.q);

	for (const { lang } of langs) {
		if (isLocale(lang)) {
			return lang;
		}
	}

	return DEFAULT_LOCALE;
}

/**
 * A value as JSON in a `<script>` data block of an HTML document: `<`, `>` and
 * `&` escaped so that none of them can close the element or start markup, and
 * U+2028 and U+2029 for old JavaScript parsers. The values come from the
 * operator's settings and translators.
 */
export function scriptJson(value: unknown): string {
	return JSON.stringify(value)
		.replaceAll("<", "\\u003c")
		.replaceAll(">", "\\u003e")
		.replaceAll("&", "\\u0026")
		.replaceAll("\u2028", "\\u2028")
		.replaceAll("\u2029", "\\u2029");
}

/** The shell data as the text of its `<script type="application/json">`. */
export function serializeShellData(data: ShellData): string {
	return scriptJson(data);
}

const STRING_SETTINGS = [
	"appName",
	"appDescription",
	"appUrl",
	"primaryColor",
	"footerText",
	"ogImageUrl",
] as const satisfies ReadonlyArray<keyof ServerConfig>;

const NUMBER_SETTINGS = [
	"maxFileSize",
	"maxFilesPerNote",
	"chunkSize",
	"maxChunkedFileSize",
	"maxExpiry",
] as const satisfies ReadonlyArray<keyof ServerConfig>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isServerConfig(value: unknown): value is ServerConfig {
	if (!isRecord(value)) {
		return false;
	}

	const strings = STRING_SETTINGS.every((key) => typeof value[key] === "string");
	const numbers = NUMBER_SETTINGS.every((key) => {
		const setting = value[key];
		return typeof setting === "number" && Number.isSafeInteger(setting) && setting > 0;
	});

	return strings && numbers;
}

/**
 * Read the shell data back, or undefined when the page carries none (the Vite
 * dev server serves the shell as it is) or not a well-formed one.
 */
export function parseShellData(text: string | null | undefined): ShellData | undefined {
	if (!text) {
		return undefined;
	}

	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		return undefined;
	}

	if (!isRecord(data)) {
		return undefined;
	}

	if (!isServerConfig(data["config"])) {
		return undefined;
	}

	if (!isLocale(data["locale"]) || !isThemePreference(data["theme"])) {
		return undefined;
	}

	return { config: data["config"], locale: data["locale"], theme: data["theme"] };
}

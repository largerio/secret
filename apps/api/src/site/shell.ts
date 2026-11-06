import type { ServerConfig } from "@largerio/secret-shared";
import { accentStyle } from "@largerio/secret-shared/accent";
import {
	DEFAULT_LOCALE,
	isLocale,
	LOCALE_COOKIE,
	LOCALES,
	type Locale,
	parseAcceptLanguage,
	SHELL_DATA_ID,
	SHELL_HEAD_MARKER,
	SHELL_HTML_TAG,
	serializeShellData,
	THEME_COOKIE,
	type ThemePreference,
} from "@largerio/secret-shared/site";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { AppConfig } from "../config.js";
import type { Messages, Site } from "./load.js";

/** The pages the server knows, each with its own head; `notFound` for any other path. */
export type Page = "home" | "note" | "manage" | "notFound";

/** What the page is rendered for: the language and theme the visitor chose, or their browser's. */
export interface Visitor {
	readonly locale: Locale;
	readonly theme: ThemePreference;
}

const OG_LOCALES: Readonly<Record<Locale, string>> = {
	en: "en_US",
	fr: "fr_FR",
	es: "es_ES",
	de: "de_DE",
	pt: "pt_PT",
	it: "it_IT",
	ja: "ja_JP",
	zh: "zh_CN",
	ru: "ru_RU",
	ko: "ko_KR",
};

const FEATURES = [
	"End-to-end encryption",
	"Zero-knowledge architecture",
	"Burn after reading",
	"Password protection",
	"File sharing",
	"QR code sharing",
	"Self-hostable",
];

/** For text and for attribute values alike: every value written here is the operator's or a translator's. */
export function escapeHtml(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

/** JSON as the text of a `<script>`, escaped as serializeShellData escapes it. */
function scriptJson(value: unknown): string {
	return JSON.stringify(value)
		.replaceAll("<", "\\u003c")
		.replaceAll(">", "\\u003e")
		.replaceAll("&", "\\u0026")
		.replaceAll(" ", "\\u2028")
		.replaceAll(" ", "\\u2029");
}

/** The settings the pages start from, as the web server used to hand them over. */
export function serverConfigOf(config: AppConfig): ServerConfig {
	return {
		appName: config.appName,
		appDescription: config.appDescription,
		appUrl: config.appUrl,
		primaryColor: config.primaryColor,
		footerText: config.footerText,
		ogImageUrl: config.ogImageUrl,
		maxFileSize: config.maxFileSize,
		maxFilesPerNote: config.maxFilesPerNote,
		chunkSize: config.chunkSize,
		maxChunkedFileSize: config.maxChunkedFileSize,
		maxExpiry: config.maxExpirySeconds,
	};
}

/** The language of the cookie the app writes, else the browser's; the theme likewise, else the system's. */
export function visitorOf(c: Context): Visitor {
	const locale = getCookie(c, LOCALE_COOKIE);
	const theme = getCookie(c, THEME_COOKIE);
	return {
		locale: isLocale(locale) ? locale : parseAcceptLanguage(c.req.header("accept-language") ?? ""),
		theme: theme === "light" || theme === "dark" ? theme : "system",
	};
}

function meta(attribute: "name" | "property", key: string, content: string): string {
	return `<meta ${attribute}="${key}" content="${escapeHtml(content)}" />`;
}

function title(text: string): string {
	return `<title>${escapeHtml(text)}</title>`;
}

/**
 * What the Svelte pages put in `<svelte:head>`, rendered here for crawlers
 * and link previews, which run no JavaScript.
 */
function pageHead(page: Page, t: (key: string) => string, config: ServerConfig): string[] {
	const noindex = meta("name", "robots", "noindex, nofollow");

	switch (page) {
		case "home": {
			const heading = t("seo_title").replaceAll("{app}", () => config.appName);
			const description = t("seo_description");
			const application = {
				"@context": "https://schema.org",
				"@type": "WebApplication",
				name: config.appName,
				url: config.appUrl,
				description,
				applicationCategory: "SecurityApplication",
				operatingSystem: "Any",
				offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
				featureList: FEATURES,
			};
			return [
				title(heading),
				meta("name", "description", description),
				meta("name", "keywords", t("seo_keywords")),
				`<link rel="canonical" href="${escapeHtml(config.appUrl)}" />`,
				meta("property", "og:title", heading),
				meta("property", "og:description", description),
				meta("property", "og:url", config.appUrl),
				meta("name", "twitter:title", heading),
				meta("name", "twitter:description", description),
				`<script type="application/ld+json">${scriptJson(application)}</script>`,
			];
		}
		case "note": {
			const heading = `${config.appName} — ${t("view_title")}`;
			const description = t("view_description");
			return [
				title(heading),
				noindex,
				meta("name", "description", description),
				meta("property", "og:title", heading),
				meta("property", "og:description", description),
			];
		}
		case "manage":
			return [title(`${config.appName} — ${t("manage_title")}`), noindex];
		case "notFound":
			return [title(`404 | ${config.appName}`)];
	}
}

/** The root layout's head, on every page. */
function layoutHead(locale: Locale, config: ServerConfig): string[] {
	const appUrl = escapeHtml(config.appUrl);
	return [
		meta("property", "og:site_name", config.appName),
		meta("property", "og:type", "website"),
		meta("property", "og:locale", OG_LOCALES[locale]),
		...LOCALES.filter((code) => code !== locale).map((code) =>
			meta("property", "og:locale:alternate", OG_LOCALES[code]),
		),
		meta("property", "og:image", config.ogImageUrl),
		meta("name", "twitter:image", config.ogImageUrl),
		meta("name", "twitter:card", "summary_large_image"),
		...LOCALES.map((code) => `<link rel="alternate" hreflang="${code}" href="${appUrl}" />`),
		`<link rel="alternate" hreflang="x-default" href="${appUrl}" />`,
	];
}

export type ShellRenderer = (page: Page, visitor: Visitor) => string;

/**
 * Render the shell for a page and a visitor: their language and theme on
 * `<html>`, with the instance's accent, and in the head the page's title and
 * meta tags and the shell data the app starts from. A page depends on nothing
 * else, so each one is rendered once.
 */
export function createShellRenderer(site: Site, config: AppConfig): ShellRenderer {
	const settings = serverConfigOf(config);
	const accent = accentStyle(settings.primaryColor);
	const style = accent === undefined ? "" : ` style="${escapeHtml(accent)}"`;
	const rendered = new Map<string, string>();

	function translator(messages: Messages, locale: Locale): (key: string) => string {
		return (key) => messages[locale][key] ?? messages[DEFAULT_LOCALE][key] ?? key;
	}

	function render(page: Page, { locale, theme }: Visitor): string {
		const t = translator(site.messages, locale);
		const head = [
			...pageHead(page, t, settings),
			...layoutHead(locale, settings),
			`<script type="application/json" id="${SHELL_DATA_ID}">${serializeShellData({ config: settings, locale, theme })}</script>`,
		].join("\n\t\t");

		// Replaced by functions: a `$&` in a setting must stay as it is.
		return site.shell
			.replace(SHELL_HTML_TAG, () => `<html lang="${locale}" data-mode="${theme}"${style}>`)
			.replace(SHELL_HEAD_MARKER, () => head);
	}

	return (page, visitor) => {
		const key = `${page} ${visitor.locale} ${visitor.theme}`;
		const cached = rendered.get(key);
		if (cached !== undefined) return cached;

		const html = render(page, visitor);
		rendered.set(key, html);
		return html;
	};
}

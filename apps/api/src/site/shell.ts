import {
	DEFAULT_LOCALE,
	LOCALES,
	type Locale,
	type Page,
	pageTitle,
	SHELL_DATA_ID,
	SHELL_HEAD_MARKER,
	SHELL_HTML_TAG,
	scriptJson,
	serializeShellData,
	type ThemePreference,
} from "@largerio/secret-shared/site";
import { type AppConfig, pageConfigOf } from "../config.js";
import { accentStyle } from "./accent.js";
import { compressedCopies, type EncodedBody } from "./encodings.js";
import { HTML_CONTENT_TYPE } from "./files.js";
import type { Messages, Site } from "./load.js";

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
function escapeHtml(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function meta(attribute: "name" | "property", key: string, content: string): string {
	return `<meta ${attribute}="${key}" content="${escapeHtml(content)}" />`;
}

/**
 * What the Svelte pages put in `<svelte:head>`, rendered here for crawlers
 * and link previews, which run no JavaScript. The title is the one the page
 * sets once it runs: both build it with pageTitle.
 */
function pageHead(page: Page, t: (key: string) => string, config: AppConfig): string[] {
	const heading = pageTitle(page, config.appName, t);
	const title = `<title>${escapeHtml(heading)}</title>`;
	const noindex = meta("name", "robots", "noindex, nofollow");

	switch (page) {
		case "home": {
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
				title,
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
			const description = t("view_description");
			return [
				title,
				noindex,
				meta("name", "description", description),
				meta("property", "og:title", heading),
				meta("property", "og:description", description),
			];
		}
		case "manage":
			return [title, noindex];
		case "notFound":
			return [title];
	}
}

/** The root layout's head, on every page. */
function layoutHead(locale: Locale, config: AppConfig): string[] {
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

/** A page as it is sent: the shell rendered, and its compressed copies. */
export interface RenderedPage {
	readonly body: Uint8Array<ArrayBuffer>;
	readonly encodings: ReadonlyArray<EncodedBody>;
}

export type ShellRenderer = (page: Page, visitor: Visitor) => RenderedPage;

/**
 * Render the shell for a page and a visitor: their language and theme on
 * `<html>`, with the instance's accent, and in the head the page's title and
 * meta tags and the shell data the app starts from. A page depends on nothing
 * else, so each one is rendered and compressed once, for the first request
 * that asks for it, and kept: four pages, ten languages and three themes, 120
 * at most. Every later request is sent the copy kept.
 */
export function createShellRenderer(site: Site, config: AppConfig): ShellRenderer {
	const pageConfig = pageConfigOf(config);
	const accent = accentStyle(config.primaryColor);
	const style = accent === undefined ? "" : ` style="${escapeHtml(accent)}"`;
	const rendered = new Map<string, RenderedPage>();

	function translator(messages: Messages, locale: Locale): (key: string) => string {
		return (key) => messages[locale][key] ?? messages[DEFAULT_LOCALE][key] ?? key;
	}

	function render(page: Page, { locale, theme }: Visitor): string {
		const t = translator(site.messages, locale);
		const head = [
			...pageHead(page, t, config),
			...layoutHead(locale, config),
			`<script type="application/json" id="${SHELL_DATA_ID}">${serializeShellData({ config: pageConfig, locale, theme })}</script>`,
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

		const body = Buffer.from(render(page, visitor));
		const sent = { body, encodings: compressedCopies(body, HTML_CONTENT_TYPE) };
		rendered.set(key, sent);
		return sent;
	};
}

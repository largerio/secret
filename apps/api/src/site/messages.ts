import type { Locale } from "@largerio/secret-shared/site";

/**
 * The messages the server writes into the pages' heads, the titles that
 * pageTitle builds among them. English, which every other language falls
 * back on, must have each one: loadSite refuses a catalog that lacks one.
 */
export const HEAD_MESSAGES = [
	"seo_title",
	"seo_description",
	"seo_keywords",
	"view_title",
	"view_description",
	"manage_title",
] as const;

export type HeadMessage = (typeof HEAD_MESSAGES)[number];

/** A language's messages, key to text, `{param}` placeholders left in. */
export type Catalog = Readonly<Record<string, string>>;

/** Every language's, English with each head message. */
export type Messages = Readonly<Record<Locale, Catalog>> & {
	readonly en: Catalog & Readonly<Record<HeadMessage, string>>;
};

/** A head message in `locale`, English filling what a translation lacks. */
export function translator(messages: Messages, locale: Locale): (key: HeadMessage) => string {
	return (key) => messages[locale][key] ?? messages.en[key];
}

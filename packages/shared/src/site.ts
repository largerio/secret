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

/** The file of the build every page is rendered from: SvelteKit's fallback. */
export const SHELL_FILE = "index.html";

/** The markers `html` lacks, each a part of the page the server could not fill in: none in a shell it can serve. */
export function missingShellMarkers(html: string): ReadonlyArray<string> {
	return [SHELL_HTML_TAG, SHELL_HEAD_MARKER].filter((marker) => !html.includes(marker));
}

/**
 * The limits an instance announces, at `GET /api/v1/config` and in the shell
 * data, and a page enforces before it sends anything: bytes, files, seconds.
 */
export const INSTANCE_LIMITS = [
	"maxFileSize",
	"maxFilesPerNote",
	"chunkSize",
	"maxChunkedFileSize",
	"maxExpiry",
] as const;

export type InstanceLimit = (typeof INSTANCE_LIMITS)[number];

export type InstanceLimits = Readonly<Record<InstanceLimit, number>>;

/** A limit as an instance may set one: a whole number above zero, exact as a double. */
export function isInstanceLimit(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** What a page reads of the instance's settings; the server writes the head and the accent itself. */
export interface PageConfig extends InstanceLimits {
	readonly appName: string;
	readonly footerText: string;
}

/** What the page starts from: the instance's settings and the visitor's choices. */
export interface ShellData {
	readonly config: PageConfig;
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

/** The theme a cookie or the shell data names, "system" for anything else. */
export function themePreferenceOf(value: unknown): ThemePreference {
	return isThemePreference(value) ? value : "system";
}

/**
 * The q each item of an `Accept-*` header gives, by lower-cased name: 1 when
 * it gives none, 0 for one that is no number, which accepts nothing as q=0
 * does. Spaces around `;` and `=` are allowed, as RFC 9110 allows them.
 */
export function headerQualities(header: string): ReadonlyMap<string, number> {
	const qualities = new Map<string, number>();
	for (const item of header.toLowerCase().split(",")) {
		const [name = "", ...parameters] = item.split(";").map((part) => part.trim());
		if (name === "") continue;
		const q = parameters
			.map((parameter) => parameter.split("=").map((part) => part.trim()))
			.find(([key]) => key === "q");
		const value = q === undefined ? 1 : Number(q[1] || Number.NaN);
		qualities.set(name, Number.isNaN(value) ? 0 : value);
	}
	return qualities;
}

/**
 * The supported language an `Accept-Language` header prefers, English failing
 * any: by q, the header's order between equals, a language given q=0 never.
 */
export function parseAcceptLanguage(header: string): Locale {
	const ranked = [...headerQualities(header)].filter(([, q]) => q > 0).sort((a, b) => b[1] - a[1]);

	for (const [range] of ranked) {
		const language = range.slice(0, 2);
		if (isLocale(language)) {
			return language;
		}
	}

	return DEFAULT_LOCALE;
}

/** The pages the server renders, each with its own head; `notFound` for any other path. */
export type Page = "home" | "note" | "manage" | "notFound";

/** The messages page titles are made of. */
export type TitleKey = "seo_title" | "view_title" | "manage_title";

/** An error page's title. */
export function errorTitle(status: number, appName: string): string {
	return `${status} | ${appName}`;
}

/**
 * A page's `<title>`. The server writes it for crawlers and link previews,
 * which run no JavaScript, and the page sets it again once it runs: both
 * build it here, so that they say the same. `t` gives a message in the
 * visitor's language, `{app}` left in.
 */
export function pageTitle(page: Page, appName: string, t: (key: TitleKey) => string): string {
	switch (page) {
		case "home":
			return t("seo_title").replaceAll("{app}", () => appName);
		case "note":
			return `${appName} — ${t("view_title")}`;
		case "manage":
			return `${appName} — ${t("manage_title")}`;
		case "notFound":
			return errorTitle(404, appName);
	}
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The settings a page reads, and only them: the shell data may carry more. */
function pageConfigOf(value: unknown): PageConfig | undefined {
	if (!isRecord(value)) {
		return undefined;
	}

	const { appName, footerText } = value;
	if (typeof appName !== "string" || typeof footerText !== "string") {
		return undefined;
	}

	const limits: Partial<Record<InstanceLimit, number>> = {};
	for (const key of INSTANCE_LIMITS) {
		const limit = value[key];
		if (!isInstanceLimit(limit)) {
			return undefined;
		}
		limits[key] = limit;
	}

	return { appName, footerText, ...(limits as InstanceLimits) };
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

	const config = pageConfigOf(data["config"]);
	if (config === undefined) {
		return undefined;
	}

	if (!isLocale(data["locale"]) || !isThemePreference(data["theme"])) {
		return undefined;
	}

	return { config, locale: data["locale"], theme: data["theme"] };
}

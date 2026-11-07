import {
	DEFAULT_LOCALE,
	INSTANCE_LIMITS,
	type InstanceLimit,
	isInstanceLimit,
	isLocale,
	LOCALE_COOKIE,
	parseShellData,
	SHELL_DATA_ID,
	type ShellData,
	THEME_COOKIE,
	themePreferenceOf,
} from "@largerio/secret-shared/site";
import { DEFAULT_CONFIG, getConfig, setConfig } from "#lib/config.svelte.js";
import { detectLocale, setLocale } from "#lib/i18n/index.svelte.js";
import { initTheme } from "#lib/theme.svelte.js";
import { readCookie } from "#lib/utils/cookies.js";

type Limits = Partial<Record<InstanceLimit, number>>;

/** What the server wrote into the shell, or undefined when the page carries none. */
export function servedShellData(doc: Document): ShellData | undefined {
	return parseShellData(doc.getElementById(SHELL_DATA_ID)?.textContent);
}

/**
 * Under `vite dev`, which serves the shell as it is, what the server would
 * have read itself: the visitor's cookies, else the browser's languages and
 * the OS theme, and an instance's default settings.
 */
export function localShellData(doc: Document): ShellData {
	const locale = readCookie(doc.cookie, LOCALE_COOKIE);
	return {
		config: DEFAULT_CONFIG,
		locale: isLocale(locale) ? locale : detectLocale(),
		theme: themePreferenceOf(readCookie(doc.cookie, THEME_COOKIE)),
	};
}

/**
 * The limits the instance's API announces, each kept only if it is one: none
 * when it cannot be asked, and the defaults stand.
 */
export async function fetchInstanceLimits(fetcher: typeof fetch = fetch): Promise<Limits> {
	let body: unknown;
	try {
		const response = await fetcher("/api/v1/config");
		if (!response.ok) return {};
		body = await response.json();
	} catch {
		return {};
	}
	if (typeof body !== "object" || body === null) return {};

	const announced = body as Record<string, unknown>;
	const limits: Limits = {};
	for (const key of INSTANCE_LIMITS) {
		const value = announced[key];
		if (isInstanceLimit(value)) limits[key] = value;
	}
	return limits;
}

/** A built page the server did not fill in, which it never serves: the defaults. */
const UNSERVED: ShellData = { config: DEFAULT_CONFIG, locale: DEFAULT_LOCALE, theme: "system" };

/**
 * Starts the page from its shell data: the instance's settings, the
 * visitor's language and theme, applied before anything renders.
 *
 * Only `vite dev` serves a page without any. There the page starts from what
 * the visitor's browser says, then narrows the defaults to the instance's
 * limits whenever its API answers, so that a dev instance with a lower
 * MAX_EXPIRY still narrows the expiry picker. A build leaves all of that out.
 */
export function startPage(doc: Document = document): void {
	const served = servedShellData(doc);
	const data = served ?? (import.meta.env.DEV ? localShellData(doc) : UNSERVED);

	setConfig(data.config);
	setLocale(data.locale);
	initTheme(data.theme);

	if (import.meta.env.DEV && served === undefined) {
		void fetchInstanceLimits().then((limits) => setConfig({ ...getConfig(), ...limits }));
	}
}

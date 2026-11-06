import type { ServerConfig } from "@largerio/secret-shared";
import {
	isLocale,
	isThemePreference,
	LOCALE_COOKIE,
	parseShellData,
	SHELL_DATA_ID,
	type ShellData,
	THEME_COOKIE,
} from "@largerio/secret-shared/site";
import { DEFAULT_CONFIG, getConfig, setConfig } from "#lib/config.svelte.js";
import { detectLocale, setLocale } from "#lib/i18n/index.svelte.js";
import { initTheme } from "#lib/theme.svelte.js";
import { readCookie } from "#lib/utils/cookies.js";

/** The limits an instance announces at `GET /api/v1/config`, under the names the config uses. */
const LIMITS = [
	"maxFileSize",
	"maxFilesPerNote",
	"maxExpiry",
	"chunkSize",
	"maxChunkedFileSize",
] as const satisfies ReadonlyArray<keyof ServerConfig>;

type Limits = { -readonly [K in (typeof LIMITS)[number]]?: number };

// Long enough for an instance under load, short enough that a page left
// waiting does not keep the defaults' wider limits for long.
const LIMITS_TIMEOUT_MS = 10_000;

/** What the server wrote into the shell, or undefined when the page carries none. */
export function servedShellData(doc: Document): ShellData | undefined {
	return parseShellData(doc.getElementById(SHELL_DATA_ID)?.textContent);
}

/**
 * Without the server's shell data (the Vite dev server serves the shell as it
 * is), what it would have read itself: the visitor's cookies, else the
 * browser's languages and the OS theme, and an instance's default settings.
 */
export function localShellData(doc: Document): ShellData {
	const locale = readCookie(doc.cookie, LOCALE_COOKIE);
	const theme = readCookie(doc.cookie, THEME_COOKIE);
	return {
		config: DEFAULT_CONFIG,
		locale: isLocale(locale) ? locale : detectLocale(),
		theme: isThemePreference(theme) ? theme : "system",
	};
}

function isLimit(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * The limits the instance's API announces, each kept only if it is one: none
 * when it cannot be asked, and the defaults stand.
 */
export async function fetchInstanceLimits(fetcher: typeof fetch = fetch): Promise<Limits> {
	let body: unknown;
	try {
		const response = await fetcher("/api/v1/config", {
			signal: AbortSignal.timeout(LIMITS_TIMEOUT_MS),
		});
		if (!response.ok) return {};
		body = await response.json();
	} catch {
		return {};
	}
	if (typeof body !== "object" || body === null) return {};

	const announced = body as Record<string, unknown>;
	const limits: Limits = {};
	for (const key of LIMITS) {
		const value = announced[key];
		if (isLimit(value)) limits[key] = value;
	}
	return limits;
}

/**
 * Starts the page from its shell data: the instance's settings, the
 * visitor's language and theme, applied before anything renders. A page
 * without any starts from what the visitor's browser says, then narrows the
 * defaults to the instance's limits once its API answers, so that a dev
 * instance with a lower MAX_EXPIRY still narrows the expiry picker. Resolves
 * once the page has all it will get.
 */
export async function startPage(
	doc: Document = document,
	fetcher: typeof fetch = fetch,
): Promise<void> {
	const served = servedShellData(doc);
	const data = served ?? localShellData(doc);

	setConfig(data.config);
	setLocale(data.locale);
	initTheme(data.theme);
	// What the server writes on <html> for a page it renders.
	doc.documentElement.lang = data.locale;
	doc.documentElement.dataset["mode"] = data.theme;

	if (served) return;
	const limits = await fetchInstanceLimits(fetcher);
	setConfig({ ...getConfig(), ...limits });
}

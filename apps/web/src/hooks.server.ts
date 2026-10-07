import type { Handle } from "@sveltejs/kit";
import { type Locale, parseAcceptLanguage } from "$lib/i18n/index.svelte";

const SUPPORTED_LOCALES: Locale[] = ["en", "fr", "es", "de", "pt", "it", "ja", "zh", "ru", "ko"];

/**
 * Applied to every HTML document response. API responses never come through
 * here: src/server/ proxies them straight to the API, which sets its own.
 */
export const DOCUMENT_SECURITY_HEADERS: Readonly<Record<string, string>> = {
	"Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
	// The URL fragment is never sent in a Referer, but no-referrer also keeps the
	// note id out of third-party logs.
	"Referrer-Policy": "no-referrer",
	"X-Content-Type-Options": "nosniff",
	"Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
	"Cross-Origin-Opener-Policy": "same-origin",
};

export const handle: Handle = async ({ event, resolve }) => {
	const acceptLang = event.request.headers.get("accept-language") ?? "";
	const cookieLang = event.cookies.get("secret_lang");
	event.locals.locale =
		cookieLang && SUPPORTED_LOCALES.includes(cookieLang as Locale)
			? (cookieLang as Locale)
			: parseAcceptLanguage(acceptLang);

	const cookieTheme = event.cookies.get("secret_theme");
	event.locals.theme = cookieTheme === "light" ? "light" : "dark";

	const response = await resolve(event, {
		transformPageChunk: ({ html }) =>
			html.replace("%lang%", event.locals.locale).replace("%theme%", event.locals.theme),
	});

	// The API sets these on its own responses, but the HTML documents — the ones
	// that carry the decryption key in the address bar and run the crypto — got
	// nothing but the CSP. HSTS matters most: SECURITY.md assumes the delivered
	// JavaScript is intact, and without it a network attacker can serve a
	// backdoored bundle over plain HTTP on the very first visit.
	for (const [name, value] of Object.entries(DOCUMENT_SECURITY_HEADERS)) {
		response.headers.set(name, value);
	}

	return response;
};

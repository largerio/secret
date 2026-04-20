import type { Handle } from "@sveltejs/kit";
import { parseAcceptLanguage, type Locale } from "$lib/i18n/index.svelte";
import { API_TARGET } from "$lib/server/env";

const PROXY_PATHS = ["/api", "/robots.txt", "/sitemap.xml"];
const SUPPORTED_LOCALES: Locale[] = ["en", "fr", "es", "de", "pt", "it", "ja", "zh", "ru", "ko"];

export const handle: Handle = async ({ event, resolve }) => {
	const acceptLang = event.request.headers.get("accept-language") ?? "";
	const cookieLang = event.cookies.get("secret_lang");
	event.locals.locale =
		cookieLang && SUPPORTED_LOCALES.includes(cookieLang as Locale)
			? (cookieLang as Locale)
			: parseAcceptLanguage(acceptLang);

	const cookieTheme = event.cookies.get("secret_theme");
	event.locals.theme = cookieTheme === "light" ? "light" : "dark";

	if (PROXY_PATHS.some((p) => event.url.pathname.startsWith(p))) {
		const target = `${API_TARGET}${event.url.pathname}${event.url.search}`;
		const hasBody = event.request.method !== "GET" && event.request.method !== "HEAD";
		const res = await fetch(target, {
			method: event.request.method,
			headers: event.request.headers,
			body: hasBody ? await event.request.arrayBuffer() : null,
		});

		const headers = new Headers(res.headers);
		// Node.js fetch auto-decompresses responses, so the body is plain text
		// but the original Content-Encoding/Content-Length headers are stale.
		// Forwarding them causes browsers to fail decoding the response.
		headers.delete("content-encoding");
		headers.delete("content-length");

		return new Response(res.body, {
			status: res.status,
			statusText: res.statusText,
			headers,
		});
	}

	return resolve(event, {
		transformPageChunk: ({ html }) =>
			html
				.replace("%lang%", event.locals.locale)
				.replace("%theme%", event.locals.theme),
	});
};

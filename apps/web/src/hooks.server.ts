import type { Handle, RequestEvent } from "@sveltejs/kit";
import { type Locale, parseAcceptLanguage } from "$lib/i18n/index.svelte";
import { API_TARGET } from "$lib/server/env";

const PROXY_PATHS = ["/api", "/robots.txt", "/sitemap.xml"];
const SUPPORTED_LOCALES: Locale[] = ["en", "fr", "es", "de", "pt", "it", "ja", "zh", "ru", "ko"];

/** Applied to every HTML document response (the API sets its own equivalents). */
export const DOCUMENT_SECURITY_HEADERS: Readonly<Record<string, string>> = {
	"Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
	// The URL fragment is never sent in a Referer, but no-referrer also keeps the
	// note id out of third-party logs.
	"Referrer-Policy": "no-referrer",
	"X-Content-Type-Options": "nosniff",
	"Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
	"Cross-Origin-Opener-Policy": "same-origin",
};

/**
 * Resolve the requesting client's address, or `undefined` when it cannot be
 * established.
 *
 * With ADDRESS_HEADER set, adapter-node *throws* if that header is missing
 * rather than returning a fallback — and it is legitimately missing on every
 * request that does not come through the reverse proxy, starting with the
 * container health check. Letting that propagate takes the whole proxy down:
 * the health check fails, the orchestrator marks the container unhealthy and
 * pulls it out of the pool, and the site 404s.
 */
function resolveClientAddress(event: RequestEvent): string | undefined {
	try {
		return event.getClientAddress();
	} catch {
		return undefined;
	}
}

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

		// Every browser request reaches the API through this proxy, so the API only
		// ever sees 127.0.0.1 as its peer and has to rely on X-Forwarded-For to
		// tell clients apart. Forwarding the client's own header verbatim would
		// let anyone mint unlimited rate-limit buckets, so it is replaced with the
		// address SvelteKit resolved — or dropped entirely when there is none.
		const headers = new Headers(event.request.headers);
		const clientAddress = resolveClientAddress(event);

		if (clientAddress) {
			headers.set("x-forwarded-for", clientAddress);
		} else {
			// Better to rate-limit everyone as one bucket than to trust a value the
			// client could have chosen. See the startup warning in getAddressMode().
			headers.delete("x-forwarded-for");
		}
		headers.delete("x-real-ip");

		const res = await fetch(target, {
			method: event.request.method,
			headers,
			body: hasBody ? await event.request.arrayBuffer() : null,
		});

		const responseHeaders = new Headers(res.headers);
		// Node.js fetch auto-decompresses responses, so the body is plain text
		// but the original Content-Encoding/Content-Length headers are stale.
		// Forwarding them causes browsers to fail decoding the response.
		responseHeaders.delete("content-encoding");
		responseHeaders.delete("content-length");

		return new Response(res.body, {
			status: res.status,
			statusText: res.statusText,
			headers: responseHeaders,
		});
	}

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

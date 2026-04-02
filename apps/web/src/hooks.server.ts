import type { Handle } from "@sveltejs/kit";

const API_TARGET = process.env["API_URL"] ?? "http://localhost:3001";

const PROXY_PATHS = ["/api", "/robots.txt", "/sitemap.xml"];

export const handle: Handle = async ({ event, resolve }) => {
	if (PROXY_PATHS.some((p) => event.url.pathname.startsWith(p))) {
		const target = `${API_TARGET}${event.url.pathname}${event.url.search}`;
		const res = await fetch(target, {
			method: event.request.method,
			headers: event.request.headers,
			body: event.request.body,
			duplex: "half",
		} as RequestInit);

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

	return resolve(event);
};

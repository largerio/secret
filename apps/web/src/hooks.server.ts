import type { Handle } from "@sveltejs/kit";

const API_TARGET = `http://localhost:${String(process.env["API_PORT"] ?? "3001")}`;

export const handle: Handle = async ({ event, resolve }) => {
	if (event.url.pathname.startsWith("/api")) {
		const target = `${API_TARGET}${event.url.pathname}${event.url.search}`;
		const res = await fetch(target, {
			method: event.request.method,
			headers: event.request.headers,
			body: event.request.body,
			duplex: "half",
		} as RequestInit);

		return new Response(res.body, {
			status: res.status,
			statusText: res.statusText,
			headers: res.headers,
		});
	}

	return resolve(event);
};

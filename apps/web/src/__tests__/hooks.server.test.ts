import type { Handle, ResolveOptions } from "@sveltejs/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/env", () => ({ API_TARGET: "http://api.test" }));

const { handle } = (await import("../hooks.server.js")) as { handle: Handle };

interface FakeEventInit {
	pathname?: string;
	search?: string;
	method?: string;
	headers?: Record<string, string>;
	cookies?: Record<string, string>;
	body?: BodyInit;
	clientAddress?: string;
}

function makeEvent(init: FakeEventInit = {}) {
	const { pathname = "/", search = "", method = "GET", headers = {}, cookies = {}, body } = init;
	const url = new URL(`http://localhost${pathname}${search}`);
	const request = new Request(url, {
		method,
		headers,
		...(body !== undefined ? { body } : {}),
	});
	return {
		url,
		request,
		locals: {} as Record<string, unknown>,
		cookies: { get: (name: string) => cookies[name] },
		getClientAddress: () => init.clientAddress ?? "203.0.113.7",
		// biome-ignore lint/suspicious/noExplicitAny: minimal SvelteKit event stub for unit testing
	} as any;
}

const resolve = vi.fn(async (_event: unknown, _opts?: ResolveOptions) => new Response("page"));

beforeEach(() => {
	resolve.mockClear();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("locale and theme resolution", () => {
	it("uses a supported language cookie over the Accept-Language header", async () => {
		const event = makeEvent({
			cookies: { secret_lang: "fr" },
			headers: { "accept-language": "de" },
		});
		await handle({ event, resolve });
		expect(event.locals.locale).toBe("fr");
	});

	it("falls back to Accept-Language when the cookie is unsupported", async () => {
		const event = makeEvent({
			cookies: { secret_lang: "xx" },
			headers: { "accept-language": "de-DE,de;q=0.9" },
		});
		await handle({ event, resolve });
		expect(event.locals.locale).toBe("de");
	});

	it("defaults theme to dark unless the cookie is 'light'", async () => {
		const dark = makeEvent();
		await handle({ event: dark, resolve });
		expect(dark.locals.theme).toBe("dark");

		const light = makeEvent({ cookies: { secret_theme: "light" } });
		await handle({ event: light, resolve });
		expect(light.locals.theme).toBe("light");
	});

	it("injects locale and theme into the rendered HTML", async () => {
		const event = makeEvent({ cookies: { secret_lang: "fr", secret_theme: "light" } });
		await handle({ event, resolve });

		const options = resolve.mock.calls[0]?.[1];
		const html = await options?.transformPageChunk?.({
			html: '<html lang="%lang%" data-mode="%theme%">',
			done: false,
		});
		expect(html).toBe('<html lang="fr" data-mode="light">');
	});
});

describe("API proxying", () => {
	it("forwards proxied paths to API_TARGET and strips stale encoding headers", async () => {
		const fetchMock = vi.fn(
			async (_url: string, _init?: RequestInit) =>
				new Response("proxied-body", {
					status: 201,
					headers: {
						"content-encoding": "gzip",
						"content-length": "999",
						"x-custom": "kept",
					},
				}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const event = makeEvent({
			pathname: "/api/v1/notes",
			search: "?foo=bar",
			method: "POST",
			body: "payload",
		});
		const res = await handle({ event, resolve });

		expect(resolve).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [target, requestInit] = fetchMock.mock.calls[0] ?? [];
		expect(target).toBe("http://api.test/api/v1/notes?foo=bar");
		expect(requestInit?.method).toBe("POST");
		expect(requestInit?.body).toBeInstanceOf(ArrayBuffer);

		expect(res.status).toBe(201);
		expect(await res.text()).toBe("proxied-body");
		expect(res.headers.get("x-custom")).toBe("kept");
		expect(res.headers.get("content-encoding")).toBeNull();
		expect(res.headers.get("content-length")).toBeNull();
	});

	it("replaces a client-supplied X-Forwarded-For with the resolved address", async () => {
		// Every browser request reaches the API through this proxy, so the API can
		// only tell clients apart by this header. Forwarding the client's own value
		// would let anyone mint unlimited rate-limit buckets.
		const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		const event = makeEvent({
			pathname: "/api/v1/notes",
			headers: { "x-forwarded-for": "1.2.3.4", "x-real-ip": "5.6.7.8" },
			clientAddress: "198.51.100.9",
		});
		await handle({ event, resolve });

		const [, requestInit] = fetchMock.mock.calls[0] ?? [];
		const headers = requestInit?.headers as Headers;
		expect(headers.get("x-forwarded-for")).toBe("198.51.100.9");
		expect(headers.get("x-real-ip")).toBeNull();
	});

	it("does not attach a body for GET proxied requests", async () => {
		const fetchMock = vi.fn(
			async (_url: string, _init?: RequestInit) => new Response("ok", { status: 200 }),
		);
		vi.stubGlobal("fetch", fetchMock);

		const event = makeEvent({ pathname: "/robots.txt" });
		await handle({ event, resolve });

		const [, requestInit] = fetchMock.mock.calls[0] ?? [];
		expect(requestInit?.body).toBeNull();
		expect(resolve).not.toHaveBeenCalled();
	});
});

describe("document security headers", () => {
	it("sets HSTS, Referrer-Policy, nosniff, Permissions-Policy and COOP on HTML", async () => {
		const res = await handle({ event: makeEvent(), resolve });

		expect(res.headers.get("strict-transport-security")).toBe(
			"max-age=63072000; includeSubDomains; preload",
		);
		expect(res.headers.get("referrer-policy")).toBe("no-referrer");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(res.headers.get("permissions-policy")).toContain("camera=()");
		expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin");
	});

	it("leaves proxied API responses untouched (the API sets its own)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("ok", { status: 200 })),
		);

		const res = await handle({ event: makeEvent({ pathname: "/api/health" }), resolve });

		expect(res.headers.get("strict-transport-security")).toBeNull();
	});
});

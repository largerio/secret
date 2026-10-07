import type { Handle, ResolveOptions } from "@sveltejs/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { handle } = (await import("../hooks.server.js")) as { handle: Handle };

interface FakeEventInit {
	headers?: Record<string, string>;
	cookies?: Record<string, string>;
}

function makeEvent(init: FakeEventInit = {}) {
	const { headers = {}, cookies = {} } = init;
	const url = new URL("http://localhost/");
	return {
		url,
		request: new Request(url, { headers }),
		locals: {} as Record<string, unknown>,
		cookies: { get: (name: string) => cookies[name] },
		// biome-ignore lint/suspicious/noExplicitAny: minimal SvelteKit event stub for unit testing
	} as any;
}

const resolve = vi.fn(async (_event: unknown, _opts?: ResolveOptions) => new Response("page"));

beforeEach(() => {
	resolve.mockClear();
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
});

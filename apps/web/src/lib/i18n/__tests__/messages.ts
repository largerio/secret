import { readFileSync } from "node:fs";
import { vi } from "vitest";
import { type Locale, loadLocale } from "../index.svelte.js";

/**
 * Answers a fetch of a language's messages as Vite's dev server would: under
 * Vitest the module names each file by its path, `/@fs/<path>`. Anything
 * else is a 404.
 */
export async function serveMessages(input: RequestInfo | URL): Promise<Response> {
	const url = String(input);
	if (!url.startsWith("/@fs/")) return new Response(null, { status: 404 });
	return new Response(readFileSync(url.slice("/@fs".length)), {
		headers: { "Content-Type": "application/json" },
	});
}

/** Loads languages from the repository's messages, as a page loads them from the build. */
export async function loadMessages(...locales: Locale[]): Promise<void> {
	const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(serveMessages);
	try {
		await Promise.all(locales.map(loadLocale));
	} finally {
		fetch.mockRestore();
	}
}

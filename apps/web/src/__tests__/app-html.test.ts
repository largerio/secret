// @vitest-environment node
import { readFileSync } from "node:fs";
import { SHELL_HEAD_MARKER, SHELL_HTML_TAG } from "@largerio/secret-shared/site";
import { describe, expect, it } from "vitest";

// The server fills the shell in at these two places, and refuses to start
// from a build whose index.html lacks either.
describe("app.html", () => {
	const html = readFileSync(new URL("../app.html", import.meta.url), "utf8");

	it("opens <html> as the server expects to replace it", () => {
		expect(html).toContain(SHELL_HTML_TAG);
	});

	it("marks where the server writes the page's head, before SvelteKit's", () => {
		const head = html.slice(html.indexOf("<head>"), html.indexOf("</head>"));
		expect(head).toContain(SHELL_HEAD_MARKER);
		expect(head.indexOf(SHELL_HEAD_MARKER)).toBeLessThan(head.indexOf("%sveltekit.head%"));
	});
});

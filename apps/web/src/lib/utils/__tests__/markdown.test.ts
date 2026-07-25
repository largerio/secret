import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../markdown.js";

describe("renderMarkdown", () => {
	it("renders markdown to HTML", async () => {
		const html = await renderMarkdown("# Title\n\nSome **bold** text.");
		expect(html).toContain("<h1>Title</h1>");
		expect(html).toContain("<strong>bold</strong>");
	});

	it("sanitizes script tags and event handlers", async () => {
		const html = await renderMarkdown('<script>alert(1)</script><img src=x onerror="alert(1)">');
		expect(html).not.toContain("<script");
		expect(html).not.toContain("onerror");
	});

	it("returns an empty string for empty input", async () => {
		expect(await renderMarkdown("")).toBe("");
	});

	// The note author controls this markdown and the reader trusts the origin,
	// so anything that can collect input or repaint the UI is a phishing vector.
	it("strips form controls a note author could use to phish the reader", async () => {
		const html = await renderMarkdown(
			'<form action="/"><input type="password" name="p"><button>Unlock</button></form>',
		);
		expect(html).not.toContain("<form");
		expect(html).not.toContain("<input");
		expect(html).not.toContain("<button");
		expect(html).not.toContain("action=");
	});

	it("strips style tags and inline styles used to fake the app UI", async () => {
		const html = await renderMarkdown(
			'<style>body{display:none}</style><div style="position:fixed;inset:0">overlay</div>',
		);
		expect(html).not.toContain("<style");
		expect(html).not.toContain("style=");
	});

	it("drops the SVG and MathML namespaces", async () => {
		// Mixed-namespace content is where DOMPurify's mXSS bypasses live, and
		// markdown needs neither.
		const html = await renderMarkdown("<svg><desc><p>x</p></desc></svg><math><mi>y</mi></math>");
		expect(html).not.toContain("<svg");
		expect(html).not.toContain("<math");
	});

	it("keeps ordinary markdown formatting intact", async () => {
		const html = await renderMarkdown(
			"# H1\n\n- item\n\n[link](https://example.com)\n\n`code`\n\n> quote",
		);
		expect(html).toContain("<h1>H1</h1>");
		expect(html).toContain("<li>item</li>");
		expect(html).toContain('href="https://example.com"');
		expect(html).toContain("<code>code</code>");
		expect(html).toContain("<blockquote>");
	});

	it("removes javascript: URLs", async () => {
		const html = await renderMarkdown("[click](javascript:alert(1))");
		expect(html).not.toContain("javascript:");
	});
});

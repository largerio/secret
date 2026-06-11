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
});

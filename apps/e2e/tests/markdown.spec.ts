import { expect, test } from "@playwright/test";
import { createNote, gotoCreate, revealNote } from "./helpers";

test("the Markdown editor renders a live preview while composing", async ({ page }) => {
	await gotoCreate(page);
	await page.getByRole("tab", { name: /Markdown/i }).click();
	await page.getByPlaceholder(/markdown/i).fill("# Hello preview\n\n**bold here**");

	// Switching to the Preview tab renders sanitized HTML (debounced ~200ms).
	await page.getByRole("button", { name: /^Preview$/i }).click();

	const preview = page.locator(".prose");
	await expect(preview.locator("h1")).toHaveText("Hello preview");
	await expect(preview.locator("strong")).toHaveText("bold here");
});

test("a Markdown note is rendered as HTML on read, not shown as raw source", async ({
	page,
	context,
}) => {
	const heading = `Rendered ${Date.now()}`;
	const shareUrl = await createNote(page, {
		markdown: `# ${heading}\n\n**emphasis** and text`,
		maxReads: 3,
	});

	const reader = await context.newPage();
	await revealNote(reader, shareUrl);

	const rendered = reader.locator(".prose");
	await expect(rendered.locator("h1")).toHaveText(heading, { timeout: 15_000 });
	await expect(rendered.locator("strong")).toHaveText("emphasis");
	// The raw Markdown markers must not leak through as literal text.
	await expect(rendered).not.toContainText("**emphasis**");
});

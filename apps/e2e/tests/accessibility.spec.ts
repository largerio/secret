import { expect, test } from "@playwright/test";
import { createNote, expectNoA11yViolations, gotoCreate, revealNote } from "./helpers";

// Accessibility regression gate. Each test drives the app into a distinct UI
// state with the shared flow helpers, waits for that state to settle, then runs
// axe-core over the live DOM (WCAG 2.0/2.1 A + AA). Kept serial via the suite's
// `workers: 1` config so single-read/burn notes don't contend.

test.describe("create page", () => {
	test("initial state has no a11y violations", async ({ page }) => {
		await gotoCreate(page);
		await expectNoA11yViolations(page, "create page (initial)");
	});

	test("opening password field has no a11y violations", async ({ page }) => {
		await gotoCreate(page);
		await page.getByRole("button", { name: "with a password" }).click();
		await page.locator("#password").fill("Tr0ub4dour&3xample");
		await expect(page.locator("#password")).toHaveValue("Tr0ub4dour&3xample");
		await expectNoA11yViolations(page, "create page (opening password)");
	});

	test("password generator has no a11y violations", async ({ page }) => {
		await gotoCreate(page);
		await page.getByRole("button", { name: "Generate a password" }).click();
		await expect(page.getByRole("button", { name: /regenerate/i })).toBeVisible();
		await expectNoA11yViolations(page, "create page (password generator)");
	});

	test("markdown formatting (write + preview) has no a11y violations", async ({ page }) => {
		await gotoCreate(page);
		await page.getByRole("button", { name: "Formatting" }).click();
		await page.locator("#note-text").fill("# Heading\n\nSome **bold** body text.");
		await expectNoA11yViolations(page, "markdown editor (write)");

		await page.getByRole("tab", { name: /preview/i }).click();
		// Wait for the debounced render to produce the prose output.
		await expect(page.locator(".prose")).toBeVisible();
		await expectNoA11yViolations(page, "markdown editor (preview)");
	});
});

test.describe("success view", () => {
	test("share screen (with QR + deletion link) has no a11y violations", async ({ page }) => {
		await createNote(page, { text: `a11y success ${Date.now()}`, password: "hunter2-secret" });
		await expect(page.getByTestId("share-url")).toBeVisible();
		await expectNoA11yViolations(page, "success view (initial)");

		// Reveal the QR code, then re-scan with the deletion link in view.
		await page.getByRole("button", { name: /QR code/i }).click();
		await expect(page.getByRole("img", { name: /QR code for the share link/i })).toBeVisible();
		await page.getByTestId("manage-link").scrollIntoViewIfNeeded();
		await expectNoA11yViolations(page, "success view (QR open)");
	});
});

test.describe("note view", () => {
	test("single-read warning has no a11y violations", async ({ page, context }) => {
		const shareUrl = await createNote(page, { text: `a11y burn ${Date.now()}` });
		const reader = await context.newPage();
		await reader.goto(shareUrl);
		await expect(reader.getByRole("button", { name: /Show the note/i })).toBeEnabled({
			timeout: 30_000,
		});
		await expectNoA11yViolations(reader, "note view (burn gate)");
	});

	test("password gate has no a11y violations", async ({ page, context }) => {
		const shareUrl = await createNote(page, {
			text: `a11y pw-gate ${Date.now()}`,
			password: "open-sesame-123",
			maxReads: 3,
		});
		const reader = await context.newPage();
		await reader.goto(shareUrl);
		// maxReads > 1: no single-read warning, just the password field.
		await expect(reader.locator("#decrypt-password")).toBeVisible({ timeout: 30_000 });
		await expectNoA11yViolations(reader, "note view (password gate)");
	});

	test("decrypted text content has no a11y violations", async ({ page, context }) => {
		const secret = `a11y decrypted ${Date.now()}`;
		const shareUrl = await createNote(page, { text: secret, maxReads: 3 });
		const reader = await context.newPage();
		await revealNote(reader, shareUrl);
		await expect(reader.getByTestId("note-text")).toHaveText(secret, { timeout: 15_000 });
		await expectNoA11yViolations(reader, "note view (decrypted)");
	});

	test("decrypted markdown content has no a11y violations", async ({ page, context }) => {
		const shareUrl = await createNote(page, {
			markdown: "# Title\n\nBody with a [link](https://example.com).",
			maxReads: 3,
		});
		const reader = await context.newPage();
		await revealNote(reader, shareUrl);
		await expect(reader.locator(".prose")).toBeVisible({ timeout: 15_000 });
		await expectNoA11yViolations(reader, "note view (decrypted markdown)");
	});
});

import { expect, type Page } from "@playwright/test";

/**
 * Fills the create form with a plaintext note, submits it (the Cap widget
 * solves the Proof-of-Work in-browser), and returns the full share URL —
 * including the `#key` fragment that the server never sees.
 *
 * Notes are created with the app default (single read / burn-after-read).
 */
export async function createTextNote(page: Page, text: string): Promise<string> {
	await page.goto("/");
	await page.locator("#note-text").fill(text);
	await page.getByRole("button", { name: /Encrypt and generate a link/i }).click();

	const shareEl = page.getByTestId("share-url");
	// PoW + client-side encryption + round-trip; allow generous headroom.
	await expect(shareEl).toBeVisible({ timeout: 30_000 });

	const shareUrl = await shareEl.getAttribute("title");
	expect(shareUrl, "share URL should be present").toBeTruthy();
	expect(shareUrl).toContain("/note/");
	expect(shareUrl).toContain("#");
	return shareUrl as string;
}

/**
 * Opens a note view, acknowledges the burn-after-read warning, and triggers
 * the decrypt. The caller asserts on the resulting state.
 */
export async function revealNote(page: Page, shareUrl: string): Promise<void> {
	await page.goto(shareUrl);
	const accept = page.getByRole("button", { name: /I understand, continue/i });
	const reveal = page.getByRole("button", { name: /Reveal the secret/i });
	// Single-read notes show a warning that must be acknowledged before the read.
	// Retry the first interaction until client-side hydration has wired up the
	// handlers — an early click would otherwise be silently dropped (the SSR'd
	// button exists before Svelte attaches its onclick).
	await expect(async () => {
		await accept.click();
		await expect(reveal).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 30_000 });
	await reveal.click();
}

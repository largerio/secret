import { expect, test } from "@playwright/test";
import { createTextNote, revealNote } from "./helpers";

test("burn-after-read: a single-read note is destroyed once viewed", async ({ page, context }) => {
	const secret = `burn me ${Date.now()}`;

	// Default note settings are single-read / burn-after-read.
	const shareUrl = await createTextNote(page, secret);

	const reader = await context.newPage();
	await revealNote(reader, shareUrl);
	await expect(reader.getByTestId("note-text")).toHaveText(secret, { timeout: 15_000 });

	// Reopening the same link must now resolve to "not found": the read was consumed.
	const second = await context.newPage();
	await second.goto(shareUrl);
	const gone = second.getByRole("heading", { name: /Note not found/i });
	await expect(gone).toBeVisible({ timeout: 15_000 });
	// It replaced the page's "Checking the link…": its title takes the focus,
	// so that the answer is announced.
	await expect(gone).toBeFocused();
});

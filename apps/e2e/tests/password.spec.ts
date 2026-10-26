import { expect, test } from "@playwright/test";
import { createNote, revealNote } from "./helpers";

test("a password-protected note decrypts with the correct password", async ({ page, context }) => {
	const secret = `password secret ${Date.now()}`;
	const password = "correct horse battery staple";

	// maxReads > 1 so a wrong-password attempt elsewhere can't consume the note.
	const shareUrl = await createNote(page, { text: secret, password, maxReads: 3 });

	const reader = await context.newPage();
	await revealNote(reader, shareUrl, { password });

	await expect(reader.getByTestId("note-text")).toHaveText(secret, { timeout: 15_000 });
});

test("a wrong password is rejected, then the correct one still works", async ({
	page,
	context,
}) => {
	const secret = `retry secret ${Date.now()}`;
	const password = "the-real-password";

	const shareUrl = await createNote(page, { text: secret, password, maxReads: 3 });

	const reader = await context.newPage();
	// The server cannot check the password, so a wrong one still spends one of
	// the three reads — and the page says so, with the reads left.
	await revealNote(reader, shareUrl, { password: "definitely-wrong" });
	await expect(reader.getByText(/That attempt counted as a read: 2 left/i)).toBeVisible({
		timeout: 15_000,
	});
	await expect(reader.getByText("2 reads left")).toBeVisible();

	// Correcting the password in the same view must now succeed.
	await reader.locator("#decrypt-password").fill(password);
	await reader.getByRole("button", { name: /Unlock the note/i }).click();

	await expect(reader.getByTestId("note-text")).toHaveText(secret, { timeout: 15_000 });
});

test("a wrong password on a burn-after-read note says the note is gone", async ({
	page,
	context,
}) => {
	const secret = `burn with password ${Date.now()}`;

	// Default settings: a single read, so the failed attempt was the only one.
	const shareUrl = await createNote(page, { text: secret, password: "the-real-password" });

	const reader = await context.newPage();
	await revealNote(reader, shareUrl, { password: "definitely-wrong" });

	await expect(reader.getByText(/This note was read-once and has now been destroyed/i)).toBeVisible(
		{ timeout: 15_000 },
	);
	// No second attempt is offered: it could only end in "not found".
	await expect(reader.locator("#decrypt-password")).toHaveCount(0);
	await expect(reader.getByRole("button", { name: /Unlock the note/i })).toHaveCount(0);
});

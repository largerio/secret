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
	// A wrong password surfaces the inline error without consuming a read.
	await revealNote(reader, shareUrl, { password: "definitely-wrong" });
	await expect(reader.getByText(/Wrong password or invalid key/i)).toBeVisible({
		timeout: 15_000,
	});

	// Correcting the password in the same view must now succeed.
	await reader.locator("#decrypt-password").fill(password);
	await reader.getByRole("button", { name: /Reveal the secret/i }).click();

	await expect(reader.getByTestId("note-text")).toHaveText(secret, { timeout: 15_000 });
});

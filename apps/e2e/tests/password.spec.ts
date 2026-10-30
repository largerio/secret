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

test("a wrong password spends no read, then the correct one still works", async ({
	page,
	context,
}) => {
	const secret = `retry secret ${Date.now()}`;
	const password = "the-real-password";

	const shareUrl = await createNote(page, { text: secret, password, maxReads: 3 });

	const reader = await context.newPage();
	// The server checks a proof of the password before it serves anything: the
	// wrong one spends an attempt, not one of the three reads.
	await revealNote(reader, shareUrl, { password: "definitely-wrong" });
	await expect(reader.getByText(/No read was spent: 4 attempts left/i)).toBeVisible({
		timeout: 15_000,
	});
	await expect(reader.getByText("3 reads left")).toBeVisible();

	// Correcting the password in the same view must now succeed.
	await reader.locator("#decrypt-password").fill(password);
	await reader.getByRole("button", { name: /Unlock the note/i }).click();

	await expect(reader.getByTestId("note-text")).toHaveText(secret, { timeout: 15_000 });
});

test("a wrong password does not burn a burn-after-read note", async ({ page, context }) => {
	const secret = `burn with password ${Date.now()}`;
	const password = "the-real-password";

	// Default settings: a single read, which the wrong password leaves alone.
	const shareUrl = await createNote(page, { text: secret, password });

	const reader = await context.newPage();
	await revealNote(reader, shareUrl, { password: "definitely-wrong" });
	await expect(reader.getByText(/No read was spent: 4 attempts left/i)).toBeVisible({
		timeout: 15_000,
	});

	await reader.locator("#decrypt-password").fill(password);
	await reader.getByRole("button", { name: /Unlock the note/i }).click();

	await expect(reader.getByTestId("note-text")).toHaveText(secret, { timeout: 15_000 });
});

test("the fifth wrong password destroys the note", async ({ page, context }) => {
	test.slow(); // Five Argon2id derivations in the browser.
	const shareUrl = await createNote(page, {
		text: `guessed ${Date.now()}`,
		password: "the-real-password",
		maxReads: 3,
	});

	const reader = await context.newPage();
	await revealNote(reader, shareUrl, { password: "wrong-1" });
	for (const [attempt, message] of [
		[2, /No read was spent: 3 attempts left/i],
		[3, /No read was spent: 2 attempts left/i],
		[4, /the next wrong password will destroy the note/i],
	] as const) {
		await expect(reader.getByText(/No read was spent/i)).toBeVisible({ timeout: 15_000 });
		await reader.locator("#decrypt-password").fill(`wrong-${String(attempt)}`);
		await reader.getByRole("button", { name: /Unlock the note/i }).click();
		await expect(reader.getByText(message)).toBeVisible({ timeout: 15_000 });
	}

	await reader.locator("#decrypt-password").fill("wrong-5");
	await reader.getByRole("button", { name: /Unlock the note/i }).click();
	await expect(reader.getByText(/That was the last attempt the note allowed/i)).toBeVisible({
		timeout: 15_000,
	});
	// No second chance is offered: the note is gone.
	await expect(reader.locator("#decrypt-password")).toHaveCount(0);

	const second = await context.newPage();
	await second.goto(shareUrl);
	await expect(second.getByText(/Note not found/i)).toBeVisible({ timeout: 15_000 });
});

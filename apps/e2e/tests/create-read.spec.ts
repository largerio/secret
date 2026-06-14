import { expect, test } from "@playwright/test";
import { createTextNote, revealNote } from "./helpers";

test("create a note, share it, and decrypt the plaintext in a fresh tab", async ({
	page,
	context,
}) => {
	const secret = `e2e secret ${Date.now()} — zero knowledge`;

	const shareUrl = await createTextNote(page, secret);

	// Open the link in a brand-new page (no shared in-memory state) to prove the
	// key travels only in the URL fragment and decryption happens client-side.
	const reader = await context.newPage();
	await revealNote(reader, shareUrl);

	// A no-password note decrypts straight from the burn acknowledgement, so the
	// separate "Reveal the secret" button is never shown — one click, not two.
	await expect(reader.getByRole("button", { name: /Reveal the secret/i })).toHaveCount(0);

	await expect(reader.getByTestId("note-text")).toHaveText(secret, { timeout: 15_000 });
});

test("a wrong key (tampered fragment) fails to decrypt", async ({ page, context }) => {
	const shareUrl = await createTextNote(page, "another secret");

	// Corrupt the fragment so client-side decryption must fail.
	const tampered = `${shareUrl.split("#")[0]}#${"A".repeat(50)}`;

	const reader = await context.newPage();
	await revealNote(reader, tampered);

	await expect(reader.getByRole("heading", { name: /Decryption failed/i })).toBeVisible({
		timeout: 15_000,
	});
});

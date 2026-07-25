import { expect, test } from "@playwright/test";
import { createNote, revealNote } from "./helpers";

test("a multi-read note is readable N times, then destroyed", async ({ page, context }) => {
	const secret = `multi-read secret ${Date.now()}`;
	const maxReads = 3;

	const shareUrl = await createNote(page, { text: secret, maxReads });

	// Each read happens in a fresh page to prove the key travels only in the URL.
	for (let i = 0; i < maxReads; i++) {
		const reader = await context.newPage();
		await revealNote(reader, shareUrl);
		await expect(reader.getByTestId("note-text"), `read #${i + 1} should succeed`).toHaveText(
			secret,
			{ timeout: 15_000 },
		);
		await reader.close();
	}

	// The reads are now exhausted: the note must be gone. Assert on the heading
	// specifically — "Service unavailable" and "Incomplete link" are rendered by
	// the same block, and this test used to pass on a rate-limit error rather
	// than on the note actually being destroyed.
	const tooMany = await context.newPage();
	await tooMany.goto(shareUrl);
	await expect(tooMany.getByRole("heading", { name: /Note not found/i })).toBeVisible({
		timeout: 15_000,
	});
});

test("the chosen expiry duration is reflected on creation and on the view page", async ({
	page,
	context,
}) => {
	const secret = `expiry secret ${Date.now()}`;

	// 3600s = the "1 hour" option. We assert the choice surfaces in the UI rather
	// than waiting for real expiry (minimum is 300s — too long for e2e).
	const shareUrl = await createNote(page, { text: secret, expirySeconds: 3600, maxReads: 3 });

	// Success screen "Expiration" fact shows the selected duration.
	await expect(page.getByText("Expiration")).toBeVisible();
	await expect(page.getByText("1 hour")).toBeVisible();

	// The view page also advertises the expiry before decryption.
	const reader = await context.newPage();
	await reader.goto(shareUrl);
	await expect(reader.getByText(/Will no longer be accessible after/i)).toBeVisible({
		timeout: 15_000,
	});
});

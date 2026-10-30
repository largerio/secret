import { expect, test } from "@playwright/test";
import { createTextNote, revealNote } from "./helpers";

test("create a note, share it, and decrypt the plaintext in a fresh tab", async ({
	page,
	context,
}) => {
	const secret = `e2e secret ${Date.now()} — zero knowledge`;

	const shareUrl = await createTextNote(page, secret);
	// The link names the note's format: the web app writes format 1.
	expect(shareUrl).toMatch(/#1\.[A-Za-z0-9_-]{43}$/);

	// Open the link in a brand-new page (no shared in-memory state) to prove the
	// key travels only in the URL fragment and decryption happens client-side.
	const reader = await context.newPage();
	await revealNote(reader, shareUrl);

	await expect(reader.getByTestId("note-text")).toHaveText(secret, { timeout: 15_000 });
});

test("a wrong key (tampered fragment) fails, and spends no read", async ({ page, context }) => {
	const secret = `another secret ${Date.now()}`;
	const shareUrl = await createTextNote(page, secret);

	// A well-formed key, but not this note's: the server refuses its proof of
	// the link. (A malformed one never gets that far: it is an incomplete link.)
	const tampered = `${shareUrl.split("#")[0]}#1.${"A".repeat(43)}`;

	const reader = await context.newPage();
	await revealNote(reader, tampered);

	await expect(reader.getByText(/Decryption failed/i)).toBeVisible({ timeout: 15_000 });

	// Nothing was served, so the single read is still there for the real link.
	const second = await context.newPage();
	await revealNote(second, shareUrl);
	await expect(second.getByTestId("note-text")).toHaveText(secret, { timeout: 15_000 });
});

test("a link truncated before the # is reported as incomplete, and does not burn the note", async ({
	page,
	context,
}) => {
	// The most common real-world failure: mail clients, chat apps and SMS
	// linkifiers routinely drop the fragment. Reporting "Note not found" sent
	// people looking for the wrong problem — and, worse, suggested their secret
	// had already been destroyed.
	const secret = `truncated link ${Date.now()}`;
	const shareUrl = await createTextNote(page, secret);

	const reader = await context.newPage();
	await reader.goto(shareUrl.split("#")[0] as string);

	await expect(reader.getByRole("heading", { name: /Incomplete link/i })).toBeVisible();

	// The read must not have been consumed: the full link still works.
	const second = await context.newPage();
	await revealNote(second, shareUrl);
	await expect(second.getByTestId("note-text")).toHaveText(secret, { timeout: 15_000 });
});

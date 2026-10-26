import { expect, test } from "@playwright/test";
import { gotoCreate, revealNote, submitNote } from "./helpers";

test("a generated password sent on its own reaches the reader as a password", async ({
	page,
	context,
}) => {
	await gotoCreate(page);
	await page.getByRole("button", { name: "Generate a password" }).click();
	await page.getByRole("button", { name: "Insert into the note" }).click();

	const generated = await page.locator("#note-text").inputValue();
	expect(generated).toHaveLength(20);
	await expect(page.getByText("Will be shown as a password to copy")).toBeVisible();

	const shareUrl = await submitNote(page);
	const reader = await context.newPage();
	await revealNote(reader, shareUrl);
	await expect(reader.getByTestId("note-secret")).toHaveText(generated, { timeout: 15_000 });
});

test("a generated password inside a longer note stays ordinary text", async ({ page, context }) => {
	await gotoCreate(page);
	await page.locator("#note-text").fill("Wi-Fi password:");
	await page.getByRole("button", { name: "Generate a password" }).click();
	await page.getByRole("button", { name: "Insert into the note" }).click();

	// Inserted where the caret was, after a space.
	const note = await page.locator("#note-text").inputValue();
	expect(note).toMatch(/^Wi-Fi password: \S{20}$/);
	await expect(page.getByText("Will be shown as a password to copy")).toHaveCount(0);

	const shareUrl = await submitNote(page);
	const reader = await context.newPage();
	await revealNote(reader, shareUrl);
	await expect(reader.getByTestId("note-text")).toHaveText(note, { timeout: 15_000 });
});

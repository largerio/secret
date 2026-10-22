import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { gotoCreate, revealNote, submitNote } from "./helpers";

test("the Password tab keeps the typed note and leaves hidden files unsent", async ({
	page,
	context,
}) => {
	const fixtureDir = mkdtempSync(path.join(tmpdir(), "secret-e2e-password-tab-"));
	const filePath = path.join(fixtureDir, "draft.txt");
	writeFileSync(filePath, "attached on the Text tab");
	const draft = `a draft the generator must not erase ${Date.now()}`;

	try {
		await gotoCreate(page);
		await page.locator("#note-text").fill(draft);
		await page.locator("#file-upload").setInputFiles(filePath);
		await expect(page.getByText("draft.txt")).toBeVisible();

		// Visiting the Password tab used to overwrite the note with a password.
		await page.getByRole("tab", { name: /Password/ }).click();
		await page.getByRole("tab", { name: /^Text/ }).click();
		await expect(page.locator("#note-text")).toHaveValue(draft);

		// Sent from the Password tab, the note carries the password only.
		await page.getByRole("tab", { name: /Password/ }).click();
		const shareUrl = await submitNote(page);

		const reader = await context.newPage();
		await revealNote(reader, shareUrl);
		const secret = reader.getByTestId("note-secret");
		await expect(secret).toBeVisible({ timeout: 15_000 });
		await expect(secret).not.toHaveText(draft);
		await expect(reader.getByText(/Attachments/i)).toHaveCount(0);
	} finally {
		rmSync(fixtureDir, { recursive: true, force: true });
	}
});

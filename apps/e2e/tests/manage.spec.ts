import { expect, test } from "@playwright/test";
import { createNote, getManageUrl, revealNote } from "./helpers.js";

// The management page is the only way to revoke a secret that has already been
// shared — the fallback the whole security story rests on — and nothing
// exercised it: no unit test, and the single e2e reference only opened the
// <details> to run an accessibility scan without ever following the link.
test.describe("management (revocation) flow", () => {
	test("deleting a note makes it unreadable for the recipient", async ({ page }) => {
		const shareUrl = await createNote(page, { text: "revoke me", maxReads: 3 });
		const manageUrl = await getManageUrl(page);

		await page.goto(manageUrl);
		page.on("dialog", (dialog) => dialog.accept());
		await page.getByRole("button", { name: /delete/i }).click();

		await expect(page.getByText(/deleted/i)).toBeVisible({ timeout: 15_000 });

		await page.goto(shareUrl);
		await expect(page.getByText(/Note not found/i)).toBeVisible();
	});

	test("a management link without its token is reported as incomplete", async ({ page }) => {
		const shareUrl = await createNote(page, { text: "keep me", maxReads: 3 });
		const manageUrl = await getManageUrl(page);

		await page.goto(manageUrl.split("#")[0] as string);
		await expect(page.getByText(/incomplete|invalid/i)).toBeVisible();

		// The note must survive a failed management attempt.
		await revealNote(page, shareUrl);
		await expect(page.getByTestId("note-text")).toContainText("keep me");
	});
});

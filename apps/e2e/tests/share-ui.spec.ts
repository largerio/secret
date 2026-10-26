import { expect, test } from "@playwright/test";
import { createNote, gotoCreate, revealNote } from "./helpers";

test("the success screen reveals a QR code on demand", async ({ page }) => {
	await createNote(page, { text: `qr secret ${Date.now()}` });

	const qrImage = page.getByRole("img", { name: /QR code for the share link/i });
	await expect(qrImage).toBeHidden();

	await page.getByRole("button", { name: /QR code/i }).click();
	await expect(qrImage).toBeVisible();
});

test.describe("clipboard", () => {
	test.use({ permissions: ["clipboard-read", "clipboard-write"] });

	test("the Copy link button copies the full share URL", async ({ page }) => {
		const shareUrl = await createNote(page, { text: `clipboard secret ${Date.now()}` });

		await page.getByRole("button", { name: "Copy the link" }).click();
		await expect(page.getByText("Link copied")).toBeVisible();

		const clipboard = await page.evaluate(() => navigator.clipboard.readText());
		expect(clipboard).toBe(shareUrl);
	});
});

test("a generated password protects the note and decrypts it end to end", async ({
	page,
	context,
}) => {
	const secret = `generated-pw secret ${Date.now()}`;

	await gotoCreate(page);
	await page.locator("#note-text").fill(secret);
	await page.locator("#max-reads").selectOption("3");

	// The generate button fills the opening password field with a random one.
	await page.getByRole("button", { name: "with a password" }).click();
	await page.getByRole("button", { name: "Generate an opening password" }).click();
	const generated = await page.locator("#password").inputValue();
	expect(generated.length).toBeGreaterThan(0);

	await page.getByRole("button", { name: /Encrypt and create the link/i }).click();
	const shareEl = page.getByTestId("share-url");
	await expect(shareEl).toBeVisible({ timeout: 30_000 });
	const shareUrl = (await shareEl.getAttribute("title")) as string;

	// The note must be readable only with the generated password.
	const reader = await context.newPage();
	await revealNote(reader, shareUrl, { password: generated });
	await expect(reader.getByTestId("note-text")).toHaveText(secret, { timeout: 15_000 });
});

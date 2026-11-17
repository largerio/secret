import { expect, test } from "@playwright/test";

// The pages are rendered in the browser: without JavaScript there would be
// nothing to see. The shell's <noscript> says why, in the language the server
// renders the page in.
const NOTE_ID = "aBcDeFgHiJkL";
const PAGES = ["/", `/note/${NOTE_ID}`, `/note/${NOTE_ID}/manage`, "/no-such-page"];

test.describe("without JavaScript", () => {
	test.use({ javaScriptEnabled: false });

	test("every page says it needs JavaScript, and what to do", async ({ page }) => {
		for (const path of PAGES) {
			await page.goto(path);
			await expect(page.getByRole("main"), path).toHaveText(
				"This page encrypts and decrypts notes in your browser, with JavaScript. Turn JavaScript on for this site, then reload the page.",
			);
		}
	});

	test.describe("in French", () => {
		test.use({
			locale: "fr-FR",
			extraHTTPHeaders: { "accept-language": "fr-FR,fr;q=0.9" },
		});

		test("says it in the browser's language", async ({ page }) => {
			await page.goto("/");
			await expect(page.locator("html")).toHaveAttribute("lang", "fr");
			await expect(page.getByRole("main")).toHaveText(
				"Cette page chiffre et déchiffre les notes dans votre navigateur, avec JavaScript. Activez JavaScript pour ce site, puis rechargez la page.",
			);
		});
	});
});

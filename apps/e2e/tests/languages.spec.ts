import { expect, type Page, test } from "@playwright/test";
import { gotoCreate } from "./helpers";

// English is in the scripts every page loads. Every other language is a file
// of the build, which a page loads before it renders, the server preloading
// the visitor's; the language menu switches the page once the language picked
// has loaded.
const FRENCH_FILE = /\/_app\/immutable\/assets\/fr\.[\w-]+\.json$/;

const ENGLISH_SUBMIT = "Encrypt and create the link";
const FRENCH_SUBMIT = "Chiffrer et créer le lien";

interface FirstRender {
	readonly lang: string;
	readonly text: string;
}

/** Keeps, before the app runs, the language and the text of the first page it renders. */
async function recordFirstRender(page: Page): Promise<void> {
	await page.addInitScript(() => {
		const observer = new MutationObserver(() => {
			const main = document.getElementById("main-content");
			if (main === null) return;
			observer.disconnect();
			Object.assign(window, {
				firstRender: { lang: document.documentElement.lang, text: main.textContent },
			});
		});
		observer.observe(document, { childList: true, subtree: true });
	});
}

test.describe("in French", () => {
	test.use({
		locale: "fr-FR",
		extraHTTPHeaders: { "accept-language": "fr-FR,fr;q=0.9" },
	});

	test("a page renders in French from the start, its messages preloaded", async ({ page }) => {
		await recordFirstRender(page);
		const requests: string[] = [];
		page.on("request", (request) => {
			if (FRENCH_FILE.test(request.url())) requests.push(request.url());
		});

		const response = await page.goto("/");
		const html = (await response?.text()) ?? "";

		expect(html).toMatch(
			/<link rel="preload" as="fetch" href="\/_app\/immutable\/assets\/fr\.[\w-]+\.json" crossorigin="anonymous" \/>/,
		);
		await expect(page.getByRole("button", { name: FRENCH_SUBMIT })).toBeVisible();
		await expect(page.locator("html")).toHaveAttribute("lang", "fr");
		const first = await page.evaluate(
			() => (window as unknown as { firstRender: FirstRender }).firstRender,
		);
		expect(first.lang).toBe("fr");
		expect(first.text).toContain(FRENCH_SUBMIT);
		expect(first.text).not.toContain(ENGLISH_SUBMIT);
		// Downloaded once: the page's fetch() took the preload's response, which
		// it would not with another mode or other credentials.
		expect(requests).toHaveLength(1);
	});
});

test.describe("the language menu", () => {
	test("switches the whole page once the language picked has loaded", async ({ page }) => {
		let requested: () => void = () => undefined;
		const fetched = new Promise<void>((resolve) => {
			requested = resolve;
		});
		let release: () => void = () => undefined;
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		await page.route(FRENCH_FILE, async (route) => {
			requested();
			await released;
			await route.continue();
		});

		await gotoCreate(page);
		await page.getByLabel("Language").selectOption("fr");
		await fetched;

		// While French loads, the page keeps its language.
		await expect(page.getByRole("button", { name: ENGLISH_SUBMIT })).toBeVisible();
		await expect(page.locator("html")).toHaveAttribute("lang", "en");

		release();
		await expect(page.getByRole("button", { name: FRENCH_SUBMIT })).toBeVisible();
		await expect(page.locator("html")).toHaveAttribute("lang", "fr");
		await expect(page.getByLabel("Langue")).toHaveValue("fr");

		// The next pages too.
		await page.reload();
		await expect(page.getByRole("button", { name: FRENCH_SUBMIT })).toBeVisible();
	});

	test("keeps the page's language when the one picked cannot load", async ({ page }) => {
		await page.route(FRENCH_FILE, (route) => route.abort());

		await gotoCreate(page);
		const menu = page.getByLabel("Language");
		await menu.selectOption("fr");

		await expect(menu).toHaveValue("en");
		await expect(page.locator("html")).toHaveAttribute("lang", "en");
		await expect(page.getByRole("button", { name: ENGLISH_SUBMIT })).toBeVisible();
	});
});

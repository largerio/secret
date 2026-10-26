import { basename } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

export interface CreateNoteOptions {
	/** Plain-text body, typed into the note's textarea. */
	text?: string;
	/** Markdown body — turns "Formatting" on, then types into the same textarea. */
	markdown?: string;
	/** Optional opening password ("with a password" in the lifetime sentence). */
	password?: string;
	/** Number of allowed reads. 1 = burn-after-read (the app default). */
	maxReads?: 1 | 3 | 10 | 100;
	/** Expiry, in seconds — must match one of EXPIRATION_OPTIONS. */
	expirySeconds?: 300 | 3600 | 86400 | 604800 | 2592000;
	/** Absolute paths of files to attach via the (hidden) file input. */
	files?: string[];
}

/**
 * Navigates to the create page and blocks until SvelteKit has hydrated the form.
 *
 * The submit button is `disabled={!mounted || !canSubmit}`, so re-typing until it
 * becomes enabled proves both that `mounted` flipped (hydration ran) and that
 * `bind:value` is live. Once that holds, the rest of the form's handlers — tab
 * switches, `<select>`s and the file input — are wired up too, so subsequent
 * interactions won't be silently dropped on a pre-hydration DOM.
 */
export async function gotoCreate(page: Page): Promise<void> {
	await page.goto("/");
	const textarea = page.locator("#note-text");
	const submit = page.getByRole("button", { name: /Encrypt and create the link/i });
	await expect(async () => {
		await textarea.fill("hydration-probe");
		await expect(submit).toBeEnabled({ timeout: 1000 });
	}).toPass({ timeout: 30_000 });
	await textarea.fill("");
}

/**
 * Fills the create form per `options`, submits it (the Cap widget solves the
 * Proof-of-Work in-browser), and returns the full share URL — including the
 * `#key` fragment that the server never sees.
 *
 * With no options it creates a single-read (burn-after-read) text note, matching
 * the app default.
 */
export async function createNote(page: Page, options: CreateNoteOptions = {}): Promise<string> {
	await gotoCreate(page);

	if (options.markdown !== undefined) {
		await page.getByRole("button", { name: "Formatting" }).click();
		await page.locator("#note-text").fill(options.markdown);
	} else {
		await page.locator("#note-text").fill(options.text ?? "");
	}

	if (options.password !== undefined) {
		await page.locator("#password-mode").selectOption("on");
		await page.locator("#password").fill(options.password);
	}
	if (options.maxReads !== undefined) {
		await page.locator("#max-reads").selectOption(String(options.maxReads));
	}
	if (options.expirySeconds !== undefined) {
		await page.locator("#expires").selectOption(String(options.expirySeconds));
	}
	if (options.files !== undefined) {
		// The input is visually hidden behind the "Attach" button; setInputFiles works regardless.
		await page.locator("#file-upload").setInputFiles(options.files);
		// Confirm the composer registered the selection before submitting.
		const first = options.files[0];
		if (first) await expect(page.getByText(basename(first))).toBeVisible();
	}

	return submitNote(page);
}

/**
 * Submits the create form as it stands and returns the full share URL. For
 * tests that fill the form themselves; createNote() covers the usual cases.
 */
export async function submitNote(page: Page): Promise<string> {
	await page.getByRole("button", { name: /Encrypt and create the link/i }).click();

	const shareEl = page.getByTestId("share-url");
	// PoW + client-side encryption + round-trip; allow generous headroom.
	await expect(shareEl).toBeVisible({ timeout: 30_000 });

	const shareUrl = await shareEl.getAttribute("title");
	expect(shareUrl, "share URL should be present").toBeTruthy();
	expect(shareUrl).toContain("/note/");
	expect(shareUrl).toContain("#");
	return shareUrl as string;
}

/**
 * Reads the management (delete) URL off the success screen. Only valid right
 * after createNote(), while the success view is still on screen — the delete
 * token, like the decryption key, is never shown again.
 */
export async function getManageUrl(page: Page): Promise<string> {
	// The success screen only offers it as a button that copies it. Needs the
	// clipboard permissions: `test.use({ permissions: ["clipboard-read", "clipboard-write"] })`.
	await page.getByTestId("manage-link").click();
	await expect(page.getByTestId("manage-link")).toHaveText(/copied/i);
	const url = await page.evaluate(() => navigator.clipboard.readText());
	expect(url, "manage URL should be present").toContain("/manage#");
	return url;
}

/**
 * Convenience wrapper that creates a default single-read text note.
 */
export async function createTextNote(page: Page, text: string): Promise<string> {
	return createNote(page, { text });
}

export interface RevealOptions {
	/** Password to type into the decrypt field before revealing. */
	password?: string;
}

/**
 * Opens a note view, optionally enters a password, and opens the note. A
 * single-read note opens in the same click, its warning shown beside the
 * button. The caller asserts on the resulting state.
 */
export async function revealNote(
	page: Page,
	shareUrl: string,
	options: RevealOptions = {},
): Promise<void> {
	await page.goto(shareUrl);
	const open = page.getByRole("button", { name: /Show the note|Unlock the note/i });

	// The button is `disabled={!mounted}`, so waiting for it to be enabled
	// guarantees Svelte has hydrated and the submit handler is attached.
	await expect(open).toBeEnabled({ timeout: 30_000 });

	if (options.password !== undefined) {
		await page.locator("#decrypt-password").fill(options.password);
	}
	await open.click();
}

/**
 * Runs axe-core against the current page state and asserts there are no WCAG
 * 2.0/2.1 A or AA violations. The caller is responsible for first navigating to —
 * and waiting for — the UI state it wants to audit (axe analyses the live DOM at
 * call time, so a stable, fully-hydrated state is required for a meaningful scan).
 *
 * `best-practice` rules are intentionally left out: the gate covers the WCAG
 * success criteria only, which keeps it actionable and stable across axe releases.
 * On failure each violation is printed as `[impact] rule-id: help` followed by the
 * offending node selectors, so a CI log points straight at the rule and element.
 */
export async function expectNoA11yViolations(page: Page, label: string): Promise<void> {
	// Settle any in-flight mount transitions before scanning: Svelte's fade/fly use
	// the Web Animations API, and a half-faded element reports washed-out colors that
	// trip color-contrast. Finishing each animation snaps it to its end (full-opacity)
	// state, making the scan deterministic regardless of machine speed.
	await page.evaluate(() => {
		for (const animation of document.getAnimations()) {
			// finish() throws on an endless animation: there is no end to jump to.
			const endless = animation.effect?.getComputedTiming().endTime === Number.POSITIVE_INFINITY;
			if (endless) animation.cancel();
			else animation.finish();
		}
	});

	const { violations } = await new AxeBuilder({ page })
		.withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
		.analyze();

	const summary = violations
		.map(
			(v) =>
				`  [${v.impact}] ${v.id}: ${v.help}\n    ${v.nodes
					.map((n) => n.target.join(" "))
					.join("\n    ")}`,
		)
		.join("\n");

	expect(violations, `a11y violations on "${label}":\n${summary}`).toEqual([]);
}

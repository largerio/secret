import { basename } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

export interface CreateNoteOptions {
	/** Plain-text body, typed into the default "Text" editor. */
	text?: string;
	/** Markdown body — switches to the Markdown tab and types into its editor. */
	markdown?: string;
	/** Optional protection password (the "Additional password" field). */
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
	const submit = page.getByRole("button", { name: /Encrypt and generate a link/i });
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
		await page.getByRole("tab", { name: /Markdown/i }).click();
		// The Markdown editor replaces #note-text; its write textarea is the only
		// textarea on the form in this mode.
		const mdEditor = page.getByPlaceholder(/markdown/i);
		await expect(mdEditor).toBeVisible();
		await mdEditor.fill(options.markdown);
	} else {
		await page.locator("#note-text").fill(options.text ?? "");
	}

	if (options.password !== undefined) {
		await page.locator("#password").fill(options.password);
	}
	if (options.maxReads !== undefined) {
		await page.locator("#max-reads").selectOption(String(options.maxReads));
	}
	if (options.expirySeconds !== undefined) {
		await page.locator("#expires").selectOption(String(options.expirySeconds));
	}
	if (options.files !== undefined) {
		// The input is visually hidden behind the dropzone; setInputFiles works regardless.
		await page.locator("#file-upload").setInputFiles(options.files);
		// Confirm the dropzone registered the selection before submitting.
		const first = options.files[0];
		if (first) await expect(page.getByText(basename(first))).toBeVisible();
	}

	await page.getByRole("button", { name: /Encrypt and generate a link/i }).click();

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
 * Opens a note view, acknowledges the burn-after-read warning when present,
 * optionally enters a password, and triggers the decrypt. The caller asserts on
 * the resulting state.
 */
export async function revealNote(
	page: Page,
	shareUrl: string,
	options: RevealOptions = {},
): Promise<void> {
	await page.goto(shareUrl);
	const accept = page.getByRole("button", { name: /I understand, continue/i });
	const reveal = page.getByRole("button", { name: /Reveal the secret/i });

	// Single-read notes gate behind a burn-after-read warning. Both the accept and
	// reveal buttons are `disabled={!mounted}`, so waiting for one to be enabled
	// guarantees Svelte has hydrated and the click handler is attached.
	if (await accept.isVisible()) {
		await expect(accept).toBeEnabled({ timeout: 30_000 });

		if (options.password === undefined) {
			// No password: acknowledging the warning decrypts in a single click —
			// the separate "Reveal the secret" button never appears.
			await accept.click();
			return;
		}

		// Password-protected: acknowledging reveals the password field + reveal CTA.
		await accept.click();
	}

	await expect(reveal).toBeEnabled({ timeout: 30_000 });

	if (options.password !== undefined) {
		await page.locator("#decrypt-password").fill(options.password);
	}
	await reveal.click();
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
		for (const animation of document.getAnimations()) animation.finish();
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

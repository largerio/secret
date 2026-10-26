<script lang="ts">
import Icon from "#lib/components/Icon.svelte";
import { getLocale, type Locale, setLocale, t } from "#lib/i18n/index.svelte.js";
import { setPreferenceCookie } from "#lib/utils/cookies.js";

const LANGS: { code: Locale; label: string }[] = [
	{ code: "en", label: "English" },
	{ code: "fr", label: "Français" },
	{ code: "es", label: "Español" },
	{ code: "de", label: "Deutsch" },
	{ code: "it", label: "Italiano" },
	{ code: "pt", label: "Português" },
	{ code: "ja", label: "日本語" },
	{ code: "zh", label: "中文" },
	{ code: "ru", label: "Русский" },
	{ code: "ko", label: "한국어" },
];

// On Windows, arrowing through a closed select fires `change` at every step:
// switching the whole page on each key press would make the list unusable.
// Choices made with the arrow keys wait for Enter or for the select to lose focus.
let browsing = false;

function pick(code: string): void {
	browsing = false;
	if (code === getLocale()) return;
	setLocale(code as Locale);
	setPreferenceCookie("secret_lang", code);
	// <html lang> otherwise keeps the SSR value until a full reload, so screen
	// readers announce the new content with the previous language's voice
	// (WCAG 3.1.1) and hyphenation/quotes stay wrong.
	document.documentElement.lang = code;
}

function onKeydown(event: KeyboardEvent & { currentTarget: HTMLSelectElement }): void {
	if (event.key.startsWith("Arrow")) browsing = true;
	if (event.key === "Enter") pick(event.currentTarget.value);
}
</script>

<!-- A native select: the platform's own picker, keyboard and screen-reader support included. -->
<label class="lang btn btn-ghost btn-sm">
	<Icon name="globe" size={14} />
	<span class="sr-only">{t("lang_label")}</span>
	<select
		value={getLocale()}
		onkeydown={onKeydown}
		onchange={(event) => {
			if (!browsing) pick(event.currentTarget.value);
		}}
		onblur={(event) => {
			if (browsing) pick(event.currentTarget.value);
		}}
	>
		{#each LANGS as lang (lang.code)}
			<option value={lang.code} lang={lang.code}>{lang.label}</option>
		{/each}
	</select>
</label>

<style>
	.lang {
		position: relative;
		gap: 6px;
		padding-right: 8px;
		font-size: 12px;
	}

	select {
		appearance: none;
		padding: 0;
		border: 0;
		background: transparent;
		color: inherit;
		font: inherit;
		cursor: pointer;
	}

	select:focus-visible {
		outline: none;
	}

	/* The ring goes around the whole control, and only for keyboard focus. */
	.lang:has(select:focus-visible) {
		outline: 2px solid var(--accent-text);
		outline-offset: 2px;
	}
</style>

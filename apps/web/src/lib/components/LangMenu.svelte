<script lang="ts">
import { isLocale } from "@largerio/secret-shared/site";
import Icon from "#lib/components/Icon.svelte";
import { chooseLocale, getLocale, type Locale, t } from "#lib/i18n/index.svelte.js";

// Each language in its own name, in the order the menu lists them: a language
// the app speaks and this leaves out does not compile.
const LANGS: Record<Locale, string> = {
	en: "English",
	fr: "Français",
	es: "Español",
	de: "Deutsch",
	it: "Italiano",
	pt: "Português",
	ja: "日本語",
	zh: "中文",
	ru: "Русский",
	ko: "한국어",
};

// On Windows, arrowing through a closed select fires `change` at every step:
// switching the whole page on each key press would make the list unusable.
// Choices made with the arrow keys wait for Enter or for the select to lose focus.
let browsing = false;

function pick(code: string): void {
	browsing = false;
	if (!isLocale(code) || code === getLocale()) return;
	chooseLocale(code);
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
		{#each Object.entries(LANGS) as [code, label] (code)}
			<option value={code} lang={code}>{label}</option>
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

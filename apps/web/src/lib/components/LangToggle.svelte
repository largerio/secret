<script lang="ts">
import { getLocale, setLocale, type Locale } from "$lib/i18n/index.svelte";
import { t } from "$lib/i18n/index.svelte";
import { setPreferenceCookie } from "$lib/utils/cookies";

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

let open = $state(false);
let rootEl: HTMLDivElement | undefined = $state();

const current = $derived(getLocale());
const currentLabel = $derived(LANGS.find((l) => l.code === current)?.code.toUpperCase() ?? "EN");

function pick(l: Locale) {
	setLocale(l);
	open = false;
	if (typeof document !== "undefined") {
		setPreferenceCookie("secret_lang", l);
		// <html lang> otherwise keeps the SSR value until a full reload, so screen
		// readers announce the new content with the previous language's voice
		// (WCAG 3.1.1) and hyphenation/quotes stay wrong.
		document.documentElement.lang = l;
	}
}

function onDocClick(e: MouseEvent) {
	if (!rootEl) return;
	if (!rootEl.contains(e.target as Node)) open = false;
}

$effect(() => {
	if (!open) return;
	document.addEventListener("click", onDocClick);
	return () => document.removeEventListener("click", onDocClick);
});
</script>

<div class="relative" bind:this={rootEl}>
	<button
		type="button"
		onclick={() => (open = !open)}
		class="mono inline-flex items-center gap-1.5 rounded-full border"
		style:background="var(--bg-2)"
		style:border-color="var(--line)"
		style:color="var(--muted)"
		style:padding="6px 10px"
		style:font-size="11px"
		style:letter-spacing="0.08em"
		style:transition="all 0.15s"
		aria-haspopup="listbox"
		aria-expanded={open}
		aria-label={t("lang_toggle")}
	>
		<span>{currentLabel}</span>
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.5"
			stroke-linecap="round"
			stroke-linejoin="round"
			width="10"
			height="10"
			aria-hidden="true"><polyline points="6 9 12 15 18 9" /></svg
		>
	</button>
	{#if open}
		<ul
			role="listbox"
			class="absolute right-0 z-20 mt-2 overflow-hidden rounded-xl border"
			style:background="var(--bg-2)"
			style:border-color="var(--line)"
			style:min-width="160px"
			style:box-shadow="0 12px 40px rgba(0,0,0,0.35)"
		>
			{#each LANGS as l (l.code)}
				<li>
					<button
						type="button"
						role="option"
						aria-selected={current === l.code}
						onclick={() => pick(l.code)}
						class="flex w-full items-center justify-between border-0"
						style:background={current === l.code ? "var(--bg-3)" : "transparent"}
						style:color={current === l.code ? "var(--text)" : "var(--muted)"}
						style:padding="8px 12px"
						style:font-size="13px"
						style:text-align="left"
					>
						<span>{l.label}</span>
						<span
							class="mono"
							style:font-size="10px"
							style:letter-spacing="0.1em"
							style:color="var(--muted-2)"
							style:text-transform="uppercase">{l.code}</span
						>
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</div>

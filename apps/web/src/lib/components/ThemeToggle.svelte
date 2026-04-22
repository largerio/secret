<script lang="ts">
import { getMode, toggleMode } from "$lib/theme.svelte";
import { t } from "$lib/i18n/index.svelte";

const mode = $derived(getMode());
</script>

<button
	type="button"
	onclick={toggleMode}
	class="inline-flex items-center justify-center rounded-full border"
	style:background="var(--bg-2)"
	style:border-color="var(--line)"
	style:color="var(--muted)"
	style:width="32px"
	style:height="32px"
	style:transition="all 0.15s"
	aria-label={t("theme_toggle")}
	title={mode === "dark" ? t("theme_light") : t("theme_dark")}
>
	{#if mode === "dark"}
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.5"
			stroke-linecap="round"
			stroke-linejoin="round"
			width="14"
			height="14"
			aria-hidden="true"
		>
			<circle cx="12" cy="12" r="4" />
			<path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
		</svg>
	{:else}
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.5"
			stroke-linecap="round"
			stroke-linejoin="round"
			width="14"
			height="14"
			aria-hidden="true"
		>
			<path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79Z" />
		</svg>
	{/if}
</button>

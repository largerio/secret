<script lang="ts">
import Icon from "#lib/components/Icon.svelte";
import { t } from "#lib/i18n/index.svelte.js";
import { getMode, toggleMode } from "#lib/theme.svelte.js";

const dark = $derived(getMode() === "dark");
</script>

<button
	type="button"
	class="btn btn-ghost btn-sm text-xs"
	aria-label={dark ? t("theme_to_light") : t("theme_to_dark")}
	onclick={toggleMode}
>
	{#key dark}
		<span class="pop inline-flex"><Icon name={dark ? "sun" : "moon"} size={14} /></span>
	{/key}
	{dark ? t("theme_light") : t("theme_dark")}
</button>

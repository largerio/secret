<script lang="ts">
import Icon from "#lib/components/Icon.svelte";
import { getConfig } from "#lib/config.svelte.js";
import { t } from "#lib/i18n/index.svelte.js";

const appName = $derived(getConfig().appName);
</script>

<a href="/" class="brand" aria-label={t("brand_home", { app: appName })}>
	<span class="mark"><Icon name="lock" size={17} stroke={2.1} /></span>
	<span class="name">{appName}</span>
</a>

<style>
	.brand {
		display: inline-flex;
		align-items: center;
		gap: 10px;
		color: var(--text);
		text-decoration: none;
	}

	.mark {
		display: grid;
		place-items: center;
		width: 34px;
		height: 34px;
		border-radius: var(--radius-lg);
		background: linear-gradient(135deg, var(--accent), var(--accent-2));
		color: var(--accent-ink);
		box-shadow:
			inset 0 1px 0 rgb(255 255 255 / 0.25),
			0 10px 24px -10px var(--accent);
	}

	.name {
		font-size: 17px;
		font-weight: 600;
		letter-spacing: -0.015em;
	}
</style>

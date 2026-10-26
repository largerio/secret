<script lang="ts">
import Icon from "#lib/components/Icon.svelte";
import LangMenu from "#lib/components/LangMenu.svelte";
import ThemeToggle from "#lib/components/ThemeToggle.svelte";
import { getConfig } from "#lib/config.svelte.js";
import { t } from "#lib/i18n/index.svelte.js";

const REPO_URL = "https://github.com/largerio/secret";

const footerText = $derived(getConfig().footerText);
</script>

<footer class="relative z-[1] border-t border-line">
	<div
		class="mx-auto flex max-w-[1080px] flex-wrap items-center justify-between gap-x-4 gap-y-1.5 px-6 py-2.5 text-xs text-faint"
	>
		<p class="m-0 flex flex-wrap items-center gap-2 py-1.5">
			{#if footerText}
				<span>{footerText}</span><span aria-hidden="true">·</span>
			{/if}
			<span>
				{t("footer_powered")}
				<a href={REPO_URL} target="_blank" rel="noopener noreferrer" class="link">Secret</a>
			</span>
			<span aria-hidden="true">·</span>
			<span>{t("footer_selfhost")}</span>
			<span aria-hidden="true">·</span>
			<a href="{REPO_URL}#how-it-works" target="_blank" rel="noopener noreferrer" class="link"
				>{t("footer_how")}</a
			>
		</p>
		<div class="flex items-center gap-0.5">
			<LangMenu />
			<ThemeToggle />
			<a
				href={REPO_URL}
				target="_blank"
				rel="noopener noreferrer"
				class="btn btn-ghost btn-sm btn-icon"
				aria-label={t("github_label")}
				title={t("github_label")}
			>
				<Icon name="github" size={15} />
			</a>
		</div>
	</div>
</footer>

<style>
	/* Underlined at rest: their colour alone barely sets them apart from the text around. */
	.link {
		color: var(--accent-text);
		text-decoration: underline;
		text-decoration-color: color-mix(in srgb, var(--accent-text) 45%, transparent);
		text-underline-offset: 3px;
	}

	.link:hover {
		text-decoration-color: currentColor;
	}
</style>

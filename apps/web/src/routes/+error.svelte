<script lang="ts">
import { page } from "$app/state";
import Icon from "#lib/components/Icon.svelte";
import NoticeIcon from "#lib/components/ui/NoticeIcon.svelte";
import PageHero from "#lib/components/ui/PageHero.svelte";
import { getConfig } from "#lib/config.svelte.js";
import { t } from "#lib/i18n/index.svelte.js";
</script>

<svelte:head>
	<title>{page.status} | {getConfig().appName}</title>
</svelte:head>

<PageHero title={String(page.status)} sub={page.error?.message ?? t("error_generic")}>
	{#snippet lead()}
		<NoticeIcon name="alert" />
	{/snippet}
</PageHero>
<div class="rise flex justify-center" style:animation-delay="0.18s">
	<a href="/" class="btn btn-primary"><Icon name="arrow-right" size={15} class="rotate-180" />{t("back_home")}</a>
</div>


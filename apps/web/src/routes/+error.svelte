<script lang="ts">
import { page } from "$app/state";
import NoticeView from "#lib/components/ui/NoticeView.svelte";
import { getConfig } from "#lib/config.svelte.js";
import { t } from "#lib/i18n/index.svelte.js";
</script>

<svelte:head>
	<title>{page.status} | {getConfig().appName}</title>
</svelte:head>

<NoticeView
	icon="alert"
	title={String(page.status)}
	sub={page.error?.message ?? t("error_generic")}
	action={{ label: t("back_home"), icon: "arrow-left" }}
/>

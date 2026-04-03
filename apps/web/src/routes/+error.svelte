<script lang="ts">
import { page } from "$app/state";
import { t } from "$lib/i18n/index.svelte";
</script>

<svelte:head>
	<title>{page.status} | {t("app_name")}</title>
</svelte:head>

<div class="flex flex-col items-center justify-center py-20 text-center">
	<p class="text-6xl font-bold text-slate-500">{page.status}</p>
	<p class="mt-4 text-lg text-slate-400">{page.error?.message ?? t("error_generic")}</p>
	<a
		href="/"
		class="mt-8 inline-flex items-center gap-2 rounded-lg bg-primary px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-primary-light"
	>
		<i class="fa-solid fa-arrow-left" aria-hidden="true"></i>
		{t("back_home")}
	</a>
</div>

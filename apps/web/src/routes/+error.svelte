<script lang="ts">
import { page } from "$app/state";
import Icon from "$lib/components/Icon.svelte";
import { t } from "$lib/i18n/index.svelte";
</script>

<svelte:head>
	<title>{page.status} | {t("app_name")}</title>
</svelte:head>

<div class="flex flex-col items-center justify-center py-20 text-center">
	<!-- Themed tokens rather than raw slate/primary utilities: text-slate-400 on the
	     light background sits at ~2.3:1, and --accent is only 3.15:1 on white (see
	     app.css) — both below AA. --accent-strong exists for exactly this. -->
	<h1 class="text-6xl font-bold" style:color="var(--muted)">{page.status}</h1>
	<p class="mt-4 text-lg" style:color="var(--text)">
		{page.error?.message ?? t("error_generic")}
	</p>
	<a
		href="/"
		class="mt-8 inline-flex items-center gap-2 rounded-lg px-6 py-3 text-sm font-semibold transition-opacity hover:opacity-90"
		style:background="var(--accent-strong)"
		style:color="var(--accent-ink)"
	>
		<Icon name="arrow-left" size={16} />
		{t("back_home")}
	</a>
</div>

<script lang="ts">
import "../app.css";
import { onMount } from "svelte";
import { getConfig, loadConfig } from "$lib/config.svelte";
import { detectLocale, getLocale, setLocale, t } from "$lib/i18n/index.svelte";

const { children } = $props();

const repoUrl = "https://github.com/largerio/secret";

const config = $derived(getConfig());
const locale = $derived(getLocale());
const appUrl = $derived(config.appUrl || "https://secret.larger.io");

onMount(async () => {
	setLocale(detectLocale());
	const loaded = await loadConfig();

	if (loaded.primaryColor && loaded.primaryColor !== "#6366f1") {
		document.documentElement.style.setProperty("--app-primary-color", loaded.primaryColor);
	}

	document.documentElement.lang = getLocale();
});
</script>

<svelte:head>
	<meta property="og:site_name" content={config.appName} />
	<meta property="og:type" content="website" />
	<meta property="og:locale" content={locale === "fr" ? "fr_FR" : "en_US"} />
	<meta property="og:locale:alternate" content={locale === "fr" ? "en_US" : "fr_FR"} />
	{#if config.ogImageUrl}
		<meta property="og:image" content={config.ogImageUrl} />
		<meta name="twitter:image" content={config.ogImageUrl} />
	{/if}
	<meta name="twitter:card" content="summary_large_image" />
	<meta name="twitter:site" content="@largerio" />
	<link rel="alternate" hreflang="en" href={appUrl} />
	<link rel="alternate" hreflang="fr" href={appUrl} />
	<link rel="alternate" hreflang="x-default" href={appUrl} />
</svelte:head>

<div class="flex min-h-screen flex-col">
	<a
		href="#main-content"
		class="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-primary focus:px-4 focus:py-2 focus:text-white"
	>
		{t("skip_to_content")}
	</a>

	<header class="border-b border-slate-800 bg-slate-900/50 backdrop-blur-sm">
		<nav class="mx-auto flex max-w-3xl items-center justify-between px-4 py-4" aria-label="Main navigation">
			<a href="/" class="flex items-center gap-2 text-xl font-bold text-white hover:text-primary-light transition-colors">
				<i class="fa-solid fa-lock" aria-hidden="true"></i>
				{config.appName}
			</a>
			<a
				href={repoUrl}
				target="_blank"
				rel="noopener noreferrer"
				class="text-sm text-slate-400 hover:text-white transition-colors"
				aria-label={t("github")}
			>
				<i class="fa-brands fa-github"></i> {t("github")}
			</a>
		</nav>
	</header>

	<main id="main-content" class="mx-auto w-full max-w-3xl flex-1 px-4 py-8">
		{@render children()}
	</main>

	<footer class="border-t border-slate-800 bg-slate-900/50">
		<div class="mx-auto max-w-3xl px-4 py-4 text-center text-sm text-slate-500">
			{#if config.footerText}
				{config.footerText} &mdash;
			{/if}
			{t("footer_powered")} <a href={repoUrl} target="_blank" rel="noopener noreferrer" class="text-slate-400 hover:text-white transition-colors">{config.appName}</a>
			&mdash; {t("footer_tagline")}
		</div>
	</footer>
</div>

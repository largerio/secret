<script lang="ts">
	import "../app.css";
	import { onMount } from "svelte";
	import { loadConfig, getConfig } from "$lib/config";
	import { detectLocale, setLocale, t } from "$lib/i18n";

	const { children } = $props();

	const repoUrl = "https://github.com/largerio/secret";

	let appName = $state("Secret");
	let appDescription = $state("Zero-knowledge encrypted sharing");
	let footerText = $state("");

	onMount(async () => {
		setLocale(detectLocale());
		const config = await loadConfig();
		appName = config.appName;
		appDescription = config.appDescription;
		footerText = config.footerText;

		if (config.primaryColor && config.primaryColor !== "#6366f1") {
			document.documentElement.style.setProperty("--app-primary-color", config.primaryColor);
		}
	});
</script>

<svelte:head>
	<meta property="og:site_name" content={appName} />
	<meta property="og:type" content="website" />
</svelte:head>

<div class="flex min-h-screen flex-col">
	<a
		href="#main-content"
		class="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-primary focus:px-4 focus:py-2 focus:text-white"
	>
		Skip to content
	</a>

	<header class="border-b border-slate-800 bg-slate-900/50 backdrop-blur-sm">
		<nav class="mx-auto flex max-w-3xl items-center justify-between px-4 py-4" aria-label="Main navigation">
			<a href="/" class="flex items-center gap-2 text-xl font-bold text-white hover:text-primary-light transition-colors">
				<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-6 w-6" aria-hidden="true">
					<rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
					<path d="M7 11V7a5 5 0 0 1 10 0v4" />
				</svg>
				{appName}
			</a>
			<a
				href={repoUrl}
				target="_blank"
				rel="noopener noreferrer"
				class="text-sm text-slate-400 hover:text-white transition-colors"
				aria-label={t("github")}
			>
				{t("github")}
			</a>
		</nav>
	</header>

	<main id="main-content" class="mx-auto w-full max-w-3xl flex-1 px-4 py-8">
		{@render children()}
	</main>

	<footer class="border-t border-slate-800 bg-slate-900/50">
		<div class="mx-auto max-w-3xl px-4 py-4 text-center text-sm text-slate-500">
			{#if footerText}
				{footerText} &mdash;
			{/if}
			{t("footer_powered")} <a href={repoUrl} target="_blank" rel="noopener noreferrer" class="text-slate-400 hover:text-white transition-colors">{appName}</a>
			&mdash; {t("footer_tagline")}
		</div>
	</footer>
</div>

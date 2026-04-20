<script lang="ts">
import "../app.css";
import { onMount } from "svelte";
import Icon from "$lib/components/Icon.svelte";
import LangToggle from "$lib/components/LangToggle.svelte";
import StepIndicator from "$lib/components/StepIndicator.svelte";
import ThemeToggle from "$lib/components/ThemeToggle.svelte";
import { getConfig } from "$lib/config.svelte";
import { getLocale, setLocale, t, type Locale } from "$lib/i18n/index.svelte";
import { initTheme } from "$lib/theme.svelte";

const { children } = $props();

const repoUrl = "https://github.com/largerio/secret";

const localeToOg: Record<string, string> = {
	en: "en_US",
	fr: "fr_FR",
	es: "es_ES",
	de: "de_DE",
	pt: "pt_PT",
	it: "it_IT",
	ja: "ja_JP",
	zh: "zh_CN",
	ru: "ru_RU",
	ko: "ko_KR",
};

const SUPPORTED: Locale[] = ["en", "fr", "es", "de", "pt", "it", "ja", "zh", "ru", "ko"];

const config = $derived(getConfig());
const locale = $derived(getLocale());
const appUrl = $derived(config.appUrl || "https://secret.larger.io");

onMount(() => {
	initTheme();
	try {
		const stored = localStorage.getItem("secret_lang");
		if (stored && SUPPORTED.includes(stored as Locale)) {
			setLocale(stored as Locale);
		}
	} catch {
		/* ignore */
	}
});
</script>

<svelte:head>
	<meta property="og:site_name" content={config.appName} />
	<meta property="og:type" content="website" />
	<meta property="og:locale" content={localeToOg[locale] ?? "en_US"} />
	{#each Object.entries(localeToOg) as [code, og]}
		{#if code !== locale}
			<meta property="og:locale:alternate" content={og} />
		{/if}
	{/each}
	{#if config.ogImageUrl}
		<meta property="og:image" content={config.ogImageUrl} />
		<meta name="twitter:image" content={config.ogImageUrl} />
	{/if}
	<meta name="twitter:card" content="summary_large_image" />
	<meta name="twitter:site" content="@largerio" />
	{#each Object.keys(localeToOg) as code}
		<link rel="alternate" hreflang={code} href={appUrl} />
	{/each}
	<link rel="alternate" hreflang="x-default" href={appUrl} />
</svelte:head>

<div class="relative z-[1] flex min-h-screen flex-col">
	<a
		href="#main-content"
		class="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:px-4 focus:py-2"
		style:background="var(--accent)"
		style:color="var(--accent-ink)"
	>
		{t("skip_to_content")}
	</a>

	<header
		class="sticky top-0 z-10 border-b"
		style:background="color-mix(in srgb, var(--bg) 85%, transparent)"
		style:backdrop-filter="blur(18px)"
		style:border-color="var(--line)"
	>
		<nav
			class="mx-auto flex max-w-[1100px] items-center justify-between gap-3 px-4 py-3 sm:px-8 sm:py-4"
			aria-label="Main navigation"
		>
			<a
				href="/"
				class="flex items-center gap-2.5 no-underline"
				style:color="var(--text)"
			>
				<span
					class="grid place-items-center rounded-lg"
					style:width="28px"
					style:height="28px"
					style:background="var(--accent)"
					style:color="var(--accent-ink)"
				>
					<Icon name="lock" size={15} />
				</span>
				<span class="flex items-baseline gap-1.5">
					<span class="serif" style:font-size="22px" style:letter-spacing="-0.02em"
						>{config.appName.toLowerCase()}</span
					>
					<span class="mono hidden sm:inline" style:color="var(--muted-2)" style:font-size="11px"
						>.larger.io</span
					>
				</span>
			</a>
			<div class="flex items-center gap-1.5 sm:gap-2">
				<LangToggle />
				<ThemeToggle />
				<a
					href={repoUrl}
					target="_blank"
					rel="noopener noreferrer"
					class="hidden items-center gap-2 rounded-lg border px-3 py-1.5 text-xs no-underline transition-colors sm:inline-flex"
					style:background="transparent"
					style:border-color="transparent"
					style:color="var(--muted)"
					aria-label={t("github")}
				>
					<Icon name="github" size={15} />
					<span>{t("github")}</span>
				</a>
				<a
					href={repoUrl}
					target="_blank"
					rel="noopener noreferrer"
					class="inline-flex items-center justify-center rounded-full border sm:hidden"
					style:background="var(--bg-2)"
					style:border-color="var(--line)"
					style:color="var(--muted)"
					style:width="32px"
					style:height="32px"
					aria-label={t("github")}
				>
					<Icon name="github" size={14} />
				</a>
			</div>
		</nav>
	</header>

	<StepIndicator />

	<main id="main-content" class="relative z-[1] mx-auto w-full max-w-[720px] flex-1 px-4 py-10 sm:px-8 sm:py-14">
		{@render children()}
	</main>

	<footer class="border-t" style:background="var(--bg-2)" style:border-color="var(--line)">
		<div
			class="mx-auto max-w-[1100px] px-4 py-5 text-center sm:px-8"
			style:color="var(--muted-2)"
			style:font-size="12px"
		>
			{#if config.footerText}
				<span>{config.footerText}</span>
				<span style:margin="0 8px">·</span>
			{/if}
			<span>{t("footer_powered")}</span>
			<a
				href={repoUrl}
				target="_blank"
				rel="noopener noreferrer"
				class="underline-offset-2 hover:underline"
				style:color="var(--muted)">{config.appName}</a
			>
			<span style:margin="0 8px">·</span>
			<span>{t("footer_tagline")}</span>
		</div>
	</footer>
</div>

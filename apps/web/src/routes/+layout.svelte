<script lang="ts">
// Fonts are bundled and served by the app itself: a font CDN would see the IP
// of every visitor, including on the page that carries the decryption key.
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "../app.css";
import { onMount } from "svelte";
import SiteFooter from "#lib/components/SiteFooter.svelte";
import Aura from "#lib/components/ui/Aura.svelte";
import { getConfig } from "#lib/config.svelte.js";
import { getLocale, t } from "#lib/i18n/index.svelte.js";
import { sweepStaged } from "#lib/notes/staging.js";

const { children } = $props();

// The files a note's read decrypted to disk are deleted once its page is
// gone: a page that crashed or was closed first leaves them to the next.
onMount(() => {
	sweepStaged().catch(() => undefined);
});

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

const config = $derived(getConfig());
const locale = $derived(getLocale());
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
	{#each Object.keys(localeToOg) as code}
		<link rel="alternate" hreflang={code} href={config.appUrl} />
	{/each}
	<link rel="alternate" hreflang="x-default" href={config.appUrl} />
</svelte:head>

<div class="relative flex min-h-screen flex-col overflow-x-clip">
	<a
		href="#main-content"
		class="btn btn-primary sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50"
	>
		{t("skip_to_content")}
	</a>

	<Aura />

	<main
		id="main-content"
		class="relative z-[1] mx-auto box-border flex w-full max-w-[640px] flex-1 flex-col gap-5 px-6 pt-[72px] pb-12 max-[600px]:pt-9"
	>
		{@render children()}
	</main>

	<SiteFooter />
</div>

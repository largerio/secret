<script lang="ts">
// Fonts are bundled and served by the app itself: a font CDN would see the IP
// of every visitor, including on the page that carries the decryption key.
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "../app.css";
import { onMount } from "svelte";
import SiteFooter from "#lib/components/SiteFooter.svelte";
import Aura from "#lib/components/ui/Aura.svelte";
import { t } from "#lib/i18n/index.svelte.js";
import { sweepStaged } from "#lib/notes/staging.js";
import { skipTo } from "#lib/utils/skipLink.js";

const { children } = $props();

let main: HTMLElement | undefined = $state();

// The files a note's read decrypted to disk are deleted once its page is
// gone: a page that crashed or was closed first leaves them to the next.
onMount(() => {
	sweepStaged().catch(() => undefined);
});
</script>

<div class="relative flex min-h-screen flex-col overflow-x-clip">
	<!-- The fragment of a note's address is its key: the link focuses the
	content without putting #main-content there. -->
	<a
		href="#main-content"
		class="btn btn-primary sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50"
		onclick={(event) => skipTo(event, main)}
	>
		{t("skip_to_content")}
	</a>

	<Aura />

	<main
		bind:this={main}
		id="main-content"
		tabindex="-1"
		class="relative z-[1] mx-auto box-border flex w-full max-w-[640px] flex-1 flex-col gap-5 px-6 pt-[72px] pb-12 max-[600px]:pt-9"
	>
		{@render children()}
	</main>

	<SiteFooter />
</div>

<style>
	/* Focused by the skip link only, to move the reading position: no ring. */
	main:focus {
		outline: none;
	}
</style>

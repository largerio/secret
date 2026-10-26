<script lang="ts">
import type { Snippet } from "svelte";
import Brand from "#lib/components/ui/Brand.svelte";

interface Props {
	title: string;
	sub?: string | undefined;
	/** Shown between the brand and the title, e.g. an empty-state icon. */
	lead?: Snippet;
	/** Shown inside the title, before its text, e.g. a success check. */
	badge?: Snippet;
}

const { title, sub, lead, badge }: Props = $props();
</script>

<header class="flex flex-col items-center gap-2 pb-2 text-center">
	<div class="rise mb-3.5">
		<Brand />
	</div>
	{#if lead}
		<div class="rise mb-2">{@render lead()}</div>
	{/if}
	<h1
		class="hero rise m-0 inline-flex items-center justify-center gap-3"
		style:animation-delay="0.06s"
	>
		{#if badge}{@render badge()}{/if}
		{title}
	</h1>
	{#if sub}
		<p class="rise m-0 max-w-[520px] text-muted" style:animation-delay="0.12s">{sub}</p>
	{/if}
</header>

<style>
	.hero {
		font-size: 28px;
		line-height: 1.2;
		font-weight: 600;
		letter-spacing: -0.025em;
	}

	@media (max-width: 600px) {
		.hero {
			font-size: 23px;
		}
	}
</style>

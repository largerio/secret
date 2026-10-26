<script lang="ts">
import { onMount, type Snippet } from "svelte";
import Brand from "#lib/components/ui/Brand.svelte";

interface Props {
	title: string;
	sub?: string | undefined;
	/**
	 * The hero replaces another screen after an action (sent, opened, failed):
	 * its title takes the focus, so the change is announced and the keyboard
	 * starts from it, and the brand, already on screen, stays still.
	 */
	afterAction?: boolean;
	/** Shown between the brand and the title, e.g. an empty-state icon. */
	lead?: Snippet;
	/** Shown inside the title, before its text, e.g. a success check. */
	badge?: Snippet;
}

const { title, sub, afterAction = false, lead, badge }: Props = $props();

const subId = $props.id();
let heading: HTMLHeadingElement | undefined = $state();

onMount(() => {
	if (afterAction) heading?.focus();
});
</script>

<header class="flex flex-col items-center gap-2 pb-2 text-center">
	<div class="mb-3.5" class:rise={!afterAction}>
		<Brand />
	</div>
	{#if lead}
		<div class="rise mb-2">{@render lead()}</div>
	{/if}
	<h1
		bind:this={heading}
		class="hero rise m-0 inline-flex items-center justify-center gap-3"
		tabindex="-1"
		aria-describedby={sub ? subId : undefined}
		style:animation-delay="0.06s"
	>
		{#if badge}{@render badge()}{/if}
		{title}
	</h1>
	{#if sub}
		<p id={subId} class="rise m-0 max-w-[520px] text-muted" style:animation-delay="0.12s">{sub}</p>
	{/if}
</header>

<style>
	.hero {
		font-size: 28px;
		line-height: 1.2;
		font-weight: 600;
		letter-spacing: -0.025em;
	}

	/* Focused by script only, to move the reading position: no ring. */
	.hero:focus {
		outline: none;
	}

	@media (max-width: 600px) {
		.hero {
			font-size: 23px;
		}
	}
</style>

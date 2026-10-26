<script lang="ts">
import type { Snippet } from "svelte";
import Icon, { type IconName } from "#lib/components/Icon.svelte";

interface Props {
	tone: "warn" | "danger";
	icon: IconName;
	title?: string;
	children: Snippet;
}

const { tone, icon, title, children }: Props = $props();
</script>

<div class="callout {tone}" role={tone === "danger" ? "alert" : "note"}>
	<Icon name={icon} size={18} class="mt-px shrink-0" />
	<div class="flex flex-col gap-0.5">
		{#if title}<span class="title">{title}</span>{/if}
		<div class="body">{@render children()}</div>
	</div>
</div>

<style>
	.callout {
		display: flex;
		align-items: flex-start;
		gap: 12px;
		padding: 12px 14px;
		border: 1px solid;
		border-radius: var(--radius-lg);
	}

	.warn {
		border-color: var(--warn-line);
		background: var(--warn-soft);
		color: var(--warn);
	}

	.danger {
		border-color: color-mix(in srgb, var(--danger) 35%, transparent);
		background: color-mix(in srgb, var(--danger) 8%, transparent);
		color: var(--danger);
	}

	.title {
		font-size: 14px;
		font-weight: 600;
		color: var(--text);
	}

	.body {
		font-size: 13.5px;
		color: var(--muted);
	}
</style>

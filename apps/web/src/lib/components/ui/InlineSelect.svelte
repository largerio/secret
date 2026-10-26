<script lang="ts" generics="T extends string | number">
interface Props {
	id: string;
	/** Read by screen readers: the sentence around the select gives sighted users the context. */
	label: string;
	value: T;
	options: readonly { readonly value: T; readonly label: string }[];
}

let { id, label, value = $bindable(), options }: Props = $props();
</script>

<label for={id} class="sr-only">{label}</label>
<select {id} bind:value class="inline-select">
	{#each options as option (option.value)}
		<option value={option.value}>{option.label}</option>
	{/each}
</select>

<style>
	/* A choice written into a sentence: plain text with a dashed underline. */
	.inline-select {
		/* As wide as the chosen option, not the longest one (Chromium; others keep the old width). */
		field-sizing: content;
		appearance: none;
		padding: 0 2px;
		border: 0;
		border-bottom: 1.5px dashed color-mix(in srgb, var(--accent) 55%, transparent);
		border-radius: 0;
		background: transparent;
		color: var(--text);
		font: inherit;
		font-weight: 500;
		transition: border-color 0.15s ease;
	}

	.inline-select:hover {
		border-bottom-style: solid;
		border-bottom-color: var(--accent);
	}
</style>

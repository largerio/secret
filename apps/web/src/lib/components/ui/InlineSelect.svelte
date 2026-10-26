<script lang="ts" generics="T extends string | number">
import Icon from "#lib/components/Icon.svelte";

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
<span class="inline-flex items-baseline">
	<select {id} bind:value class="inline-choice">
		{#each options as option (option.value)}
			<option value={option.value}>{option.label}</option>
		{/each}
	</select>
	<Icon name="chevron-down" size={12} class="ml-0.5 self-center text-accent-text" />
</span>

<style>
	select {
		/* As wide as the chosen option, not the longest one (Chromium; others keep the old width). */
		field-sizing: content;
		appearance: none;
	}
</style>

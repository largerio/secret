<script lang="ts">
import { glyphKind } from "#lib/utils/password.js";

interface Props {
	value: string;
	/** Announce the value when it changes, e.g. on regenerate. */
	live?: boolean;
	/** Set on the plain copy, the one that holds the value as text. */
	testid?: string;
}

const { value, live = false, testid }: Props = $props();
</script>

<!--
	Each class of character in its own colour, so look-alikes are told apart.
	Screen readers get the whole string at once instead of one span at a time;
	that copy is left out of selections, or selecting the password by hand
	would copy it twice.
-->
<span aria-hidden="true">
	{#each value as char, index (index)}<span class={glyphKind(char)}>{char}</span>{/each}
</span>
<span class="sr-only select-none" aria-live={live ? "polite" : undefined} data-testid={testid}
	>{value}</span
>

<style>
	.upper {
		color: var(--text);
	}

	.lower {
		color: var(--muted);
	}

	.digit {
		color: var(--accent-text);
	}

	.symbol {
		color: var(--accent-2-text);
	}
</style>

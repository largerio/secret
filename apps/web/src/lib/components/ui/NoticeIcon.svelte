<script lang="ts">
import Icon, { type IconName } from "#lib/components/Icon.svelte";

const { name }: { name: IconName } = $props();
</script>

<!-- The quiet disc above the title of an empty state: a missing note, an error. -->
<span class="notice-icon"><Icon {name} size={24} stroke={1.8} /></span>

<style>
	.notice-icon {
		display: grid;
		place-items: center;
		width: 56px;
		height: 56px;
		border-radius: 50%;
		background: var(--soft);
		color: var(--muted);
	}
</style>

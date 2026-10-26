<script lang="ts">
import Icon from "#lib/components/Icon.svelte";
</script>

<!-- The check that pops in beside a title once something is done. -->
<span class="badge"><Icon name="check" size={16} stroke={2.6} /></span>

<style>
	.badge {
		display: inline-grid;
		place-items: center;
		width: 30px;
		height: 30px;
		flex: none;
		border-radius: 50%;
		background: var(--accent-soft);
		color: var(--accent-text);
		animation: ring-in 0.45s cubic-bezier(0.2, 0.7, 0.2, 1) 0.15s backwards;
	}

	@keyframes ring-in {
		from {
			opacity: 0;
			transform: scale(0.5);
		}
	}
</style>

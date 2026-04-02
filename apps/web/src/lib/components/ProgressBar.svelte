<script lang="ts">
interface Props {
	progress: number;
	label?: string;
	animated?: boolean;
}

let { progress, label, animated = false }: Props = $props();
const clamped = $derived(Math.min(100, Math.max(0, progress)));
const isActive = $derived(animated && clamped < 100);
</script>

<div class="w-full space-y-1">
	{#if label}
		<div class="flex justify-between text-xs text-slate-400">
			<span>{label}</span>
			<span>{Math.round(clamped)}%</span>
		</div>
	{/if}
	<div class="h-3 w-full rounded-full bg-slate-700 overflow-hidden" role="progressbar" aria-valuenow={Math.round(clamped)} aria-valuemin={0} aria-valuemax={100}>
		<div
			class="h-full rounded-full transition-all duration-300 ease-out {isActive
				? 'progress-shimmer'
				: 'bg-gradient-to-r from-primary to-primary-light'}"
			style="width: {clamped}%"
		></div>
	</div>
</div>

<script lang="ts">
	interface Props {
		progress: number;
		label?: string;
	}

	let { progress, label }: Props = $props();
</script>

<div class="w-full space-y-1">
	{#if label}
		<div class="flex justify-between text-xs text-slate-400">
			<span>{label}</span>
			<span>{Math.round(progress)}%</span>
		</div>
	{/if}
	<div class="h-2 w-full rounded-full bg-slate-700 overflow-hidden">
		<div
			class="h-full rounded-full bg-primary transition-all duration-300 ease-out"
			style="width: {Math.min(100, Math.max(0, progress))}%"
		></div>
	</div>
</div>

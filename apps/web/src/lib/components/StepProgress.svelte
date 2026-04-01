<script lang="ts">
import ProgressBar from "./ProgressBar.svelte";

interface Step {
	key: string;
	label: string;
	icon: string;
}

interface Props {
	steps: Step[];
	currentStep: number;
	progress: number;
	label?: string;
}

let { steps, currentStep, progress, label }: Props = $props();
</script>

<div class="w-full space-y-4">
	<div class="flex items-center justify-center gap-0">
		{#each steps as step, i}
			{#if i > 0}
				<div class="h-0.5 flex-1 max-w-12 {i <= currentStep ? 'bg-primary' : 'bg-slate-700'}">
				</div>
			{/if}
			<div class="flex flex-col items-center gap-1">
				<div
					class="flex h-8 w-8 items-center justify-center rounded-full text-sm transition-colors
						{i < currentStep
						? 'bg-primary text-white'
						: i === currentStep
							? 'border-2 border-primary text-primary animate-pulse'
							: 'border border-slate-600 text-slate-500'}"
				>
					{#if i < currentStep}
						<i class="fa-solid fa-check text-xs"></i>
					{:else}
						<i class="{step.icon} text-xs"></i>
					{/if}
				</div>
				<span
					class="text-[10px] font-medium {i <= currentStep ? 'text-slate-300' : 'text-slate-500'}"
				>
					{step.label}
				</span>
			</div>
		{/each}
	</div>

	<ProgressBar progress={progress} animated={currentStep < steps.length - 1} />

	{#if label}
		<p class="text-center text-xs text-slate-500">{label}</p>
	{/if}
</div>

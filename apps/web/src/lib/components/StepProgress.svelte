<script lang="ts">
import Icon, { type IconName } from "./Icon.svelte";
import ProgressBar from "./ProgressBar.svelte";

interface Step {
	key: string;
	label: string;
	/** Name of an Icon.svelte glyph. */
	icon: IconName;
}

interface Props {
	steps: Step[];
	currentStep: number;
	progress: number;
	label?: string;
}

let { steps, currentStep, progress, label }: Props = $props();
</script>

<div class="w-full space-y-4" role="group" aria-label="Progress">
	<div class="flex items-center justify-center gap-0">
		{#each steps as step, i}
			{#if i > 0}
				<div
					class="h-0.5 flex-1 max-w-12"
					style:background={i <= currentStep ? "var(--accent)" : "var(--line)"}
				>
				</div>
			{/if}
			<div class="flex flex-col items-center gap-1">
				<div
					class="flex h-8 w-8 items-center justify-center rounded-full text-sm transition-colors
						{i === currentStep ? 'border-2 animate-pulse' : ''}{i > currentStep ? 'border' : ''}"
					style:background={i < currentStep ? "var(--accent)" : "transparent"}
					style:border-color={i === currentStep
						? "var(--accent)"
						: i > currentStep
							? "var(--line-2)"
							: "transparent"}
					style:color={i < currentStep
						? "var(--accent-ink)"
						: i === currentStep
							? "var(--accent)"
							: "var(--muted-2)"}
				>
					{#if i < currentStep}
						<Icon name="check" size={14} />
					{:else}
						<Icon name={step.icon} size={14} />
					{/if}
				</div>
				<span
					class="text-[10px] font-medium"
					style:color={i <= currentStep ? "var(--text)" : "var(--muted-2)"}
				>
					{step.label}
				</span>
			</div>
		{/each}
	</div>

	<ProgressBar progress={progress} animated={currentStep < steps.length - 1} />

	{#if label}
		<p class="text-center text-xs" style:color="var(--muted-2)">{label}</p>
	{/if}
</div>

<script lang="ts">
import Icon from "#lib/components/Icon.svelte";
import { t } from "#lib/i18n/index.svelte.js";
import type { ProgressView } from "#lib/utils/progress.js";

interface Props {
	view: ProgressView;
	label: string;
	detail: string;
	/** The three steps, in order: e.g. encryption, upload, link. */
	steps: readonly [string, string, string];
}

const { view, label, detail, steps }: Props = $props();

// r = 28 in a 64-unit box.
const CIRCUMFERENCE = 2 * Math.PI * 28;

const done = $derived(view.step === 2);
const measured = $derived(view.percent !== null);
const offset = $derived(
	view.percent === null ? CIRCUMFERENCE * 0.75 : CIRCUMFERENCE * (1 - view.percent / 100),
);
</script>

<section class="card pop flex flex-col items-center gap-4 px-6 pt-9 pb-7 text-center">
	<span class="progress-ring" aria-hidden="true">
		<span class="arc" class:animate-spin={!measured}>
			<svg viewBox="0 0 64 64" width="64" height="64">
				<circle cx="32" cy="32" r="28" class="track" />
				<circle
					cx="32"
					cy="32"
					r="28"
					class="value"
					stroke-dasharray={CIRCUMFERENCE}
					stroke-dashoffset={offset}
				/>
			</svg>
		</span>
		{#if done}
			<span class="pop"><Icon name="check" size={24} stroke={2.6} /></span>
		{:else}
			<Icon name="lock" size={22} />
		{/if}
	</span>

	<div class="flex flex-col gap-1">
		<p class="m-0 text-[15px] font-medium">{label}</p>
		<p class="m-0 text-[13px] text-faint">{detail}</p>
	</div>

	<div
		class="bar"
		role="progressbar"
		aria-label={label}
		aria-valuemin={0}
		aria-valuemax={100}
		aria-valuenow={view.percent ?? undefined}
	>
		{#if measured}
			<div class="fill" style:width="{view.percent}%"></div>
		{:else}
			<div class="fill sweep"></div>
		{/if}
	</div>

	<ol
		class="m-0 flex list-none flex-wrap justify-center gap-x-4 gap-y-2 p-0 text-[12.5px]"
		aria-label={t("progress_steps")}
	>
		{#each steps as name, index (index)}
			{@const state = index < view.step || done ? "done" : index === view.step ? "active" : "todo"}
			<li class="step {state}" aria-current={state === "active" ? "step" : undefined}>
				{#if state === "done"}
					<Icon name="check" size={13} stroke={2.4} class="text-accent-text" />
				{:else}
					<span class="dot" aria-hidden="true"></span>
				{/if}
				{name}
			</li>
		{/each}
	</ol>

	<!-- Announces each step as it starts, not every percent of it. -->
	<p class="sr-only" role="status">{steps[view.step]}</p>
</section>

<style>
	.progress-ring {
		position: relative;
		display: grid;
		place-items: center;
		width: 64px;
		height: 64px;
		color: var(--accent-text);
	}

	.arc {
		position: absolute;
		inset: 0;
	}

	.arc svg {
		display: block;
		transform: rotate(-90deg);
	}

	circle {
		fill: none;
		stroke-width: 3;
	}

	.track {
		stroke: var(--accent-soft);
	}

	.value {
		stroke: var(--accent);
		stroke-linecap: round;
		transition: stroke-dashoffset 0.25s linear;
	}

	.bar {
		position: relative;
		width: 100%;
		max-width: 320px;
		height: 4px;
		overflow: hidden;
		border-radius: 99px;
		background: var(--soft);
	}

	.fill {
		height: 100%;
		border-radius: 99px;
		background: linear-gradient(90deg, var(--accent), var(--accent-2));
		transition: width 0.25s linear;
	}

	.sweep {
		position: absolute;
		inset: 0 auto 0 0;
		width: 40%;
		animation: sweep 1.3s cubic-bezier(0.4, 0, 0.2, 1) infinite;
	}

	@keyframes sweep {
		from {
			transform: translateX(-100%);
		}
		to {
			transform: translateX(250%);
		}
	}

	.step {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		color: var(--faint);
	}

	.step.done {
		color: var(--muted);
	}

	.step.active {
		color: var(--text);
		font-weight: 500;
	}

	.dot {
		width: 7px;
		height: 7px;
		border: 1.5px solid var(--line-strong);
		border-radius: 50%;
	}

	.active .dot {
		border-color: var(--accent);
		background: var(--accent);
	}
</style>

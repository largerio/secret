<script lang="ts">
import { onMount } from "svelte";
import Icon from "#lib/components/Icon.svelte";
import PasswordGlyphs from "#lib/components/ui/PasswordGlyphs.svelte";
import { type MessageKey, t } from "#lib/i18n/index.svelte.js";
import {
	type EntropyRating,
	entropyMeter,
	generatePassword,
	type PasswordOptions,
	passwordEntropy,
	rateEntropy,
} from "#lib/utils/password.js";

interface Props {
	oninsert: (password: string) => void;
	onclose: () => void;
}

const { oninsert, onclose }: Props = $props();

type CharClass = keyof Required<PasswordOptions>;

const CLASSES: { key: CharClass; sample: string; label: MessageKey }[] = [
	{ key: "uppercase", sample: "A–Z", label: "gen_upper" },
	{ key: "lowercase", sample: "a–z", label: "gen_lower" },
	{ key: "digits", sample: "0–9", label: "gen_digits" },
	{ key: "symbols", sample: "!@#", label: "gen_symbols" },
];

const RATINGS: Record<EntropyRating, MessageKey> = {
	weak: "gen_weak",
	fair: "gen_fair",
	strong: "gen_strong",
	excellent: "gen_excellent",
};

let length = $state(20);
let enabled = $state<Required<PasswordOptions>>({
	uppercase: true,
	lowercase: true,
	digits: true,
	symbols: true,
});
let value = $state(generatePassword(20));
let insertButton: HTMLButtonElement | undefined = $state();

const bits = $derived(passwordEntropy(length, enabled));

// The panel opens above the button that opened it: start the keyboard on its main action.
onMount(() => insertButton?.focus());

// Regenerate on explicit intent only (a button, a class toggle, releasing the
// slider), never continuously while the slider is dragged.
function regenerate(): void {
	value = generatePassword(length, enabled);
}

function toggle(key: CharClass): void {
	const next = { ...enabled, [key]: !enabled[key] };
	// At least one class stays on: an empty charset would silently fall back.
	if (!Object.values(next).some(Boolean)) return;
	enabled = next;
	regenerate();
}
</script>

<div class="generator pop" role="group" aria-labelledby="generator-title">
	<div class="flex items-center justify-between gap-2">
		<span id="generator-title" class="inline-flex items-center gap-2 text-[13px] font-semibold">
			<Icon name="key" size={14} class="text-accent-text" />{t("tool_generate")}
		</span>
		<button
			type="button"
			class="btn btn-ghost btn-sm btn-icon h-7 w-7"
			aria-label={t("gen_close")}
			onclick={onclose}
		>
			<Icon name="x" size={14} />
		</button>
	</div>

	<div class="value-box">
		<div class="flex items-center gap-2">
			<p class="value m-0">
				<span class="sr-only">{t("gen_value")}:</span>
				<PasswordGlyphs {value} live />
			</p>
			<button
				type="button"
				class="btn btn-ghost btn-sm btn-icon shrink-0"
				aria-label={t("gen_regenerate")}
				title={t("gen_regenerate")}
				onclick={regenerate}
			>
				<Icon name="refresh" size={15} />
			</button>
		</div>
		<div class="flex items-center gap-2.5 pr-1.5">
			<div class="meter" aria-hidden="true">
				<div class="meter-fill" style:width="{entropyMeter(bits)}%"></div>
			</div>
			<span class="text-xs whitespace-nowrap text-muted">
				<strong class="font-semibold text-accent-text">{t(RATINGS[rateEntropy(bits)])}</strong>
				· {t("gen_bits", { bits })}
			</span>
		</div>
	</div>

	<div class="flex flex-wrap items-center gap-x-5 gap-y-3">
		<label class="flex min-w-[200px] flex-1 items-center gap-2.5 text-[13px] text-muted">
			{t("gen_length")}
			<input
				type="range"
				min="8"
				max="64"
				bind:value={length}
				onchange={regenerate}
				class="flex-1 accent-[var(--accent)]"
			/>
			<span class="min-w-5 text-right font-mono text-xs text-text">{length}</span>
		</label>
		<div class="flex gap-1.5" role="group" aria-label={t("gen_classes")}>
			{#each CLASSES as option (option.key)}
				<button
					type="button"
					class="class-toggle"
					aria-pressed={enabled[option.key]}
					onclick={() => toggle(option.key)}
				>
					{#if enabled[option.key]}<Icon name="check" size={11} stroke={2.6} />{/if}
					{option.sample}<span class="sr-only">, {t(option.label)}</span>
				</button>
			{/each}
		</div>
	</div>

	<div class="flex justify-end gap-2">
		<button type="button" class="btn btn-outline btn-sm" onclick={onclose}>{t("cancel")}</button>
		<button
			type="button"
			class="btn btn-primary btn-sm"
			bind:this={insertButton}
			onclick={() => oninsert(value)}
		>
			{t("gen_insert")}
		</button>
	</div>
</div>

<style>
	.generator {
		display: flex;
		flex-direction: column;
		gap: 12px;
		margin: 0 12px 12px;
		padding: 16px;
		border: 1px solid color-mix(in srgb, var(--accent) 18%, transparent);
		border-radius: var(--radius-lg);
		background: color-mix(in srgb, var(--accent) 5%, var(--surface));
	}

	.value-box {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 12px 8px 12px 14px;
		border: 1px solid var(--line);
		border-radius: var(--radius-lg);
		background: var(--surface);
	}

	.value {
		flex: 1;
		min-width: 0;
		font-family: var(--font-mono);
		font-size: 16px;
		line-height: 1.5;
		letter-spacing: 0.03em;
		word-break: break-all;
	}

	.meter {
		flex: 1;
		height: 4px;
		overflow: hidden;
		border-radius: 99px;
		background: var(--soft);
	}

	.meter-fill {
		height: 100%;
		border-radius: 99px;
		background: linear-gradient(90deg, var(--accent), var(--accent-2));
		transition: width 0.3s ease;
	}

	.class-toggle {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		height: 30px;
		padding: 0 10px;
		border: 1px solid var(--field-line);
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--muted);
		font-family: var(--font-mono);
		font-size: 12px;
		transition:
			background-color 0.15s ease,
			border-color 0.15s ease,
			color 0.15s ease;
	}

	/* On: a check mark as well as the tint, so the state does not rest on colour. */
	.class-toggle[aria-pressed="true"] {
		border-color: var(--accent-text);
		background: var(--accent-soft);
		color: var(--accent-text);
	}
</style>

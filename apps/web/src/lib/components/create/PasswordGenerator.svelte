<script lang="ts">
import Icon from "#lib/components/Icon.svelte";
import { type MessageKey, t } from "#lib/i18n/index.svelte.js";
import {
	type EntropyRating,
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

const bits = $derived(passwordEntropy(length, enabled));

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

function charKind(ch: string): string {
	if (/[0-9]/.test(ch)) return "digit";
	if (/[A-Z]/.test(ch)) return "upper";
	if (/[a-z]/.test(ch)) return "lower";
	return "symbol";
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
			<code class="value" aria-label={t("gen_value")}>
				{#each value as ch, i (i)}<span class={charKind(ch)}>{ch}</span>{/each}
			</code>
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
				<div class="meter-fill" style:width="{Math.min(100, Math.round(bits / 1.3))}%"></div>
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
					aria-label={t(option.label)}
					title={t(option.label)}
					onclick={() => toggle(option.key)}
				>
					{option.sample}
				</button>
			{/each}
		</div>
	</div>

	<div class="flex justify-end gap-2">
		<button type="button" class="btn btn-outline btn-sm" onclick={onclose}>{t("cancel")}</button>
		<button type="button" class="btn btn-primary btn-sm" onclick={() => oninsert(value)}>
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
		height: 30px;
		padding: 0 10px;
		border: 1px solid var(--line-strong);
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

	.class-toggle[aria-pressed="true"] {
		border-color: color-mix(in srgb, var(--accent) 55%, transparent);
		background: var(--accent-soft);
		color: var(--accent-text);
	}
</style>

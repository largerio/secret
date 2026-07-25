<script lang="ts">
import { onMount } from "svelte";
import Icon from "$lib/components/Icon.svelte";
import { t } from "$lib/i18n/index.svelte";
import { copyWithFeedback } from "$lib/utils/clipboard";
import { generatePassword } from "$lib/utils/password";

interface Props {
	value: string;
}

let { value = $bindable("") }: Props = $props();

let length = $state(20);
let uppercase = $state(true);
let lowercase = $state(true);
let digits = $state(true);
let symbols = $state(true);
let copied = $state(false);
let copyFailed = $state(false);

// Regenerate only on explicit user intent (mount, the regenerate button, a
// charset toggle, or releasing the length slider) — never continuously while
// the slider is being dragged.
function generate(): void {
	value = generatePassword(length, { uppercase, lowercase, digits, symbols });
}

onMount(generate);

async function copyPassword(): Promise<void> {
	// Goes through the shared helper so the plain-HTTP fallback applies here too;
	// the previous inline call swallowed every failure, leaving the user
	// convinced they had copied their password when they had not.
	copyFailed = !(await copyWithFeedback(value, (v) => (copied = v), 1400));
}

function charColor(ch: string): string {
	if (/[A-Z]/.test(ch)) return "var(--text)";
	if (/[a-z]/.test(ch)) return "var(--muted)";
	if (/[0-9]/.test(ch)) return "#eab308";
	return "var(--accent)";
}
</script>

<div
	class="rounded-2xl border"
	style:background="var(--bg-2)"
	style:border-color="var(--line)"
	style:padding="20px"
>
	<div
		class="mono mb-3 inline-flex items-center gap-1.5 uppercase"
		style:color="var(--muted)"
		style:font-size="11px"
		style:letter-spacing="0.12em"
	>
		<Icon name="key" size={11} />
		<span>{t("generate_password")}</span>
	</div>

	<div
		class="mb-3.5 break-all rounded-xl border"
		style:background="var(--bg-3)"
		style:border-color="var(--line)"
		style:padding="20px 18px"
		style:font-family="var(--font-mono)"
		style:font-size="18px"
		style:letter-spacing="0.02em"
		style:line-height="1.5"
		style:min-height="60px"
	>
		{#if value}
			{#each value.split("") as ch, i (i)}
				<span style:color={charColor(ch)}>{ch}</span>
			{/each}
		{:else}
			<span style:color="var(--muted-2)">—</span>
		{/if}
	</div>

	<div class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
		<div class="flex flex-1 items-center gap-3">
			<span
				class="mono uppercase"
				style:color="var(--muted)"
				style:font-size="11px"
				style:letter-spacing="0.08em"
				style:min-width="56px">{t("password_length")}</span
			>
			<input
				type="range"
				min="8"
				max="64"
				bind:value={length}
				onchange={generate}
				aria-label={t("password_length")}
				class="flex-1 cursor-pointer"
				style:accent-color="var(--accent)"
			/>
			<span
				class="mono tabular-nums"
				style:color="var(--text)"
				style:font-size="13px"
				style:min-width="24px"
				style:text-align="right">{length}</span
			>
		</div>
		<div class="flex gap-1.5">
			<button
				type="button"
				onclick={generate}
				class="inline-flex items-center gap-1.5 rounded-lg border transition-colors"
				style:background="var(--bg-3)"
				style:border-color="var(--line)"
				style:color="var(--text)"
				style:padding="8px 12px"
				style:font-size="12px"
			>
				<Icon name="dice" size={13} />
				<span>{t("regenerate")}</span>
			</button>
			<button
				type="button"
				onclick={copyPassword}
				disabled={!value}
				class="inline-flex items-center gap-1.5 rounded-lg border transition-colors disabled:opacity-50"
				style:background="var(--accent-strong)"
				style:border-color="transparent"
				style:color="var(--accent-ink)"
				style:padding="8px 14px"
				style:font-size="12px"
			>
				{#if copied}
					<Icon name="check" size={13} />
					<span>{t("password_copied")}</span>
				{:else}
					<Icon name="copy" size={13} />
					<span>{t("copy_button")}</span>
				{/if}
			</button>
		</div>
		{#if copyFailed}
			<p role="alert" style:color="var(--accent)" style:font-size="12px" style:margin="8px 0 0">
				{t("error_clipboard")}
			</p>
		{/if}
	</div>

	<div class="flex flex-wrap gap-2">
		{#each [{ k: "upper", label: t("password_uppercase") }, { k: "lower", label: t("password_lowercase") }, { k: "digits", label: t("password_digits") }, { k: "symbols", label: t("password_symbols") }] as o (o.k)}
			{@const on = o.k === "upper" ? uppercase : o.k === "lower" ? lowercase : o.k === "digits" ? digits : symbols}
			<button
				type="button"
				onclick={() => {
					if (o.k === "upper") uppercase = !uppercase;
					else if (o.k === "lower") lowercase = !lowercase;
					else if (o.k === "digits") digits = !digits;
					else symbols = !symbols;
					generate();
				}}
				class="mono inline-flex items-center gap-1.5 rounded-lg border transition-all"
				style:background={on ? "var(--accent-soft)" : "var(--bg-3)"}
				style:border-color={on ? "var(--accent)" : "var(--line)"}
				style:color={on ? "var(--text)" : "var(--muted)"}
				style:padding="8px 14px"
				style:font-size="12px"
			>
				<span
					class="inline-grid place-items-center rounded"
					style:width="10px"
					style:height="10px"
					style:background={on ? "var(--accent)" : "transparent"}
					style:border={on ? "1px solid var(--accent)" : "1px solid var(--line-2)"}
				>
					{#if on}
						<Icon name="check" size={8} />
					{/if}
				</span>
				<span>{o.label}</span>
			</button>
		{/each}
	</div>
</div>

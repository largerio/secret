<script lang="ts">
import { tick } from "svelte";
import InlineSelect from "#lib/components/ui/InlineSelect.svelte";
import PasswordField from "#lib/components/ui/PasswordField.svelte";
import { getConfig } from "#lib/config.svelte.js";
import { t, tn } from "#lib/i18n/index.svelte.js";
import { splitTemplate } from "#lib/i18n/template.js";
import { allowedExpirationOptions } from "#lib/server-config.js";
import { generatePassword } from "#lib/utils/password.js";

interface Props {
	expiresIn: number;
	maxReads: number;
	password: string;
	/** Whether the note asks for a password; the value is only sent while this is on. */
	passwordOn: boolean;
}

let {
	expiresIn = $bindable(),
	maxReads = $bindable(),
	password = $bindable(),
	passwordOn = $bindable(),
}: Props = $props();

const READS = [1, 3, 10, 100];

let passwordField: PasswordField | undefined = $state();

// Only offer what this instance will accept: the API enforces MAX_EXPIRY per
// request, and listing options beyond it produced a raw 400 on submit.
const expiryOptions = $derived(
	allowedExpirationOptions(getConfig().maxExpiry).map((option) => ({
		value: option.value,
		label: t(option.labelKey),
	})),
);

const readOptions = $derived(
	READS.map((count) => ({
		value: count,
		label: tn("reads_count", count),
	})),
);

const sentence = $derived(splitTemplate(t("life_sentence")));

// A selection carried over from a looser config would silently fail, so snap
// it back into range.
$effect(() => {
	if (!expiryOptions.some((option) => option.value === expiresIn)) {
		expiresIn = expiryOptions[expiryOptions.length - 1]?.value ?? expiresIn;
	}
});

async function togglePassword(): Promise<void> {
	passwordOn = !passwordOn;
	if (!passwordOn) return;
	await tick();
	passwordField?.focus();
}

// The recipient may have to type it: letters and digits only, still ~92 bits.
function generateOpeningPassword(): void {
	password = generatePassword(16, { uppercase: true, lowercase: true, digits: true });
}
</script>

<div class="rise flex flex-col gap-4" style:animation-delay="0.24s">
	<p class="m-0 text-center text-sm leading-[2.1] text-muted">
		{#each sentence as segment, index (index)}
			{#if "text" in segment}
				{segment.text}
			{:else if segment.slot === "reads"}
				<InlineSelect id="max-reads" label={t("life_reads")} bind:value={maxReads} options={readOptions} />
			{:else if segment.slot === "expiry"}
				<InlineSelect
					id="expires"
					label={t("life_expiry")}
					bind:value={expiresIn}
					options={expiryOptions}
				/>
			{/if}
		{/each}
		<span class="mx-1.5 text-line-strong" aria-hidden="true">·</span>
		<button
			type="button"
			class="password-toggle"
			aria-expanded={passwordOn}
			aria-controls={passwordOn ? "extra-password" : undefined}
			onclick={togglePassword}
		>
			{passwordOn ? t("life_remove_password") : t("life_add_password")}
		</button>
	</p>

	{#if passwordOn}
		<div id="extra-password" class="pop flex flex-col gap-1.5">
			<label for="password" class="text-[13px] font-medium">
				{t("pw_extra_label")} <span class="font-normal text-faint">— {t("pw_extra_hint")}</span>
			</label>
			<PasswordField
				bind:this={passwordField}
				id="password"
				bind:value={password}
				placeholder={t("pw_extra_placeholder")}
				autocomplete="new-password"
				generateLabel={t("pw_extra_generate")}
				ongenerate={generateOpeningPassword}
			/>
		</div>
	{/if}
</div>

<style>
	.password-toggle {
		padding: 0 2px;
		border: 0;
		border-bottom: 1.5px dashed color-mix(in srgb, var(--accent) 55%, transparent);
		background: transparent;
		color: var(--text);
		font: inherit;
		font-weight: 500;
		transition: border-color 0.15s ease;
	}

	.password-toggle:hover {
		border-bottom-style: solid;
		border-bottom-color: var(--accent);
	}
</style>

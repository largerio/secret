<script lang="ts">
import { tick } from "svelte";
import Icon from "#lib/components/Icon.svelte";
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
	/** Shown under the password field, which is then marked invalid. */
	passwordError?: string;
}

let {
	expiresIn = $bindable(),
	maxReads = $bindable(),
	password = $bindable(),
	passwordOn = $bindable(),
	passwordError = "",
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
	READS.map((count) => ({ value: count, label: tn("reads_count", count) })),
);

// Like the other choices in the sentence, this one shows its current value.
const passwordOptions = $derived([
	{ value: "off", label: t("life_without_password") },
	{ value: "on", label: t("life_with_password") },
]);

const sentence = $derived(splitTemplate(t("life_sentence")));

// A selection carried over from a looser config would silently fail, so snap
// it back into range.
$effect(() => {
	if (!expiryOptions.some((option) => option.value === expiresIn)) {
		expiresIn = expiryOptions[expiryOptions.length - 1]?.value ?? expiresIn;
	}
});

async function setPasswordOn(on: boolean): Promise<void> {
	passwordOn = on;
	if (!on) return;
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
		<InlineSelect
			id="password-mode"
			label={t("life_password")}
			bind:value={() => (passwordOn ? "on" : "off"), (mode) => setPasswordOn(mode === "on")}
			options={passwordOptions}
		/>
	</p>

	{#if passwordOn}
		<div class="pop flex flex-col gap-1.5">
			<label for="password" class="text-[13px] font-medium">
				{t("pw_extra_label")} <span class="font-normal text-faint">— {t("pw_extra_hint")}</span>
			</label>
			<PasswordField
				bind:this={passwordField}
				id="password"
				bind:value={password}
				placeholder={t("pw_extra_placeholder")}
				invalid={passwordError !== ""}
				describedby={passwordError ? "password-error" : undefined}
				generateLabel={t("pw_extra_generate")}
				ongenerate={generateOpeningPassword}
			/>
			{#if passwordError}
				<p id="password-error" class="pop m-0 flex items-start gap-2 text-[13px] text-danger" role="alert">
					<Icon name="alert" size={15} class="mt-0.5 shrink-0" />{passwordError}
				</p>
			{/if}
		</div>
	{/if}
</div>

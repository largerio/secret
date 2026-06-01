<script lang="ts">
import { EXPIRATION_OPTIONS } from "@secret/shared";
import Icon from "$lib/components/Icon.svelte";
import { t } from "$lib/i18n/index.svelte";
import { generatePassword, getPasswordStrength } from "$lib/utils/password";

interface Props {
	password: string;
	expiresIn: number;
	maxReads: string;
}

let { password = $bindable(), expiresIn = $bindable(), maxReads = $bindable() }: Props = $props();

let showPassword = $state(false);

const READS = [
	{ value: "1", key: "reads_1" as const },
	{ value: "3", key: "reads_3" as const },
	{ value: "10", key: "reads_10" as const },
	{ value: "100", key: "reads_100" as const },
];

const pwStrength = $derived(getPasswordStrength(password));

function generatePwField() {
	password = generatePassword();
	showPassword = true;
}
</script>

<div
	class="mb-6 rounded-2xl border"
	style:background="var(--bg-2)"
	style:border-color="var(--line)"
	style:padding="24px"
>
	<div
		class="mono mb-4 inline-flex items-center gap-1.5 uppercase"
		style:font-size="11px"
		style:letter-spacing="0.12em"
		style:color="var(--muted)"
	>
		<Icon name="shield" size={11} />
		<span>{t("security_settings")}</span>
	</div>

	<div class="flex flex-col gap-5">
		<div class="flex flex-col gap-2">
			<label
				for="password"
				class="mono flex items-center gap-1.5 uppercase"
				style:font-size="11px"
				style:letter-spacing="0.08em"
				style:color="var(--muted)"
			>
				<Icon name="lock" size={12} />
				<span>{t("password_add_label")}</span>
			</label>
			<div class="relative">
				<input
					id="password"
					type={showPassword ? "text" : "password"}
					bind:value={password}
					placeholder={t("password_add_placeholder")}
					autocomplete="off"
					class="w-full rounded-xl border outline-none transition-colors"
					style:background="var(--bg-2)"
					style:border-color="var(--line)"
					style:color="var(--text)"
					style:padding="12px 88px 12px 14px"
					style:font-size="14px"
				/>
				<div
					class="absolute flex gap-0.5"
					style:right="8px"
					style:top="50%"
					style:transform="translateY(-50%)"
				>
					<button
						type="button"
						onclick={generatePwField}
						class="inline-flex items-center justify-center rounded-md border-0 bg-transparent"
						style:color="var(--muted)"
						style:padding="6px 8px"
						title={t("generate")}
						aria-label={t("generate")}
					>
						<Icon name="dice" size={14} />
					</button>
					<button
						type="button"
						onclick={() => (showPassword = !showPassword)}
						class="inline-flex items-center justify-center rounded-md border-0 bg-transparent"
						style:color="var(--muted)"
						style:padding="6px 8px"
						title={showPassword ? t("hide_password") : t("show_password")}
						aria-label={showPassword ? t("hide_password") : t("show_password")}
					>
						<Icon name={showPassword ? "eye-off" : "eye"} size={14} />
					</button>
				</div>
			</div>
			{#if password}
				<div class="flex items-center gap-2.5" style:margin-top="4px">
					<div
						class="flex-1 overflow-hidden rounded-full"
						style:height="4px"
						style:background="var(--bg-3)"
					>
						<div
							class="h-full transition-all"
							style:width="{(pwStrength.score / 5) * 100}%"
							style:background={pwStrength.color}
						></div>
					</div>
					<span
						class="mono"
						style:font-size="10px"
						style:color={pwStrength.color}
						style:min-width="70px"
						style:text-align="right">{pwStrength.labelKey ? t(pwStrength.labelKey) : ""}</span
					>
				</div>
			{/if}
			<span class="mono" style:font-size="11px" style:color="var(--muted-2)">
				{t("password_add_hint")}
			</span>
		</div>

		<div class="grid grid-cols-1 gap-5 sm:grid-cols-2">
			<div class="flex flex-col gap-2">
				<label
					for="expires"
					class="mono flex items-center gap-1.5 uppercase"
					style:font-size="11px"
					style:letter-spacing="0.08em"
					style:color="var(--muted)"
				>
					<Icon name="clock" size={12} />
					<span>{t("expires_label")}</span>
				</label>
				<select
					id="expires"
					bind:value={expiresIn}
					class="w-full rounded-xl border outline-none transition-colors"
					style:background="var(--bg-2)"
					style:border-color="var(--line)"
					style:color="var(--text)"
					style:padding="12px 14px"
					style:font-size="14px"
				>
					{#each EXPIRATION_OPTIONS as option (option.value)}
						<option value={option.value}>{t(option.labelKey)}</option>
					{/each}
				</select>
			</div>

			<div class="flex flex-col gap-2">
				<label
					for="max-reads"
					class="mono flex items-center gap-1.5 uppercase"
					style:font-size="11px"
					style:letter-spacing="0.08em"
					style:color="var(--muted)"
				>
					<Icon name="eye" size={12} />
					<span>{t("max_reads_label")}</span>
				</label>
				<select
					id="max-reads"
					bind:value={maxReads}
					class="w-full rounded-xl border outline-none transition-colors"
					style:background="var(--bg-2)"
					style:border-color="var(--line)"
					style:color="var(--text)"
					style:padding="12px 14px"
					style:font-size="14px"
				>
					{#each READS as r (r.value)}
						<option value={r.value}>{t(r.key)}</option>
					{/each}
				</select>
			</div>
		</div>
	</div>
</div>

<script lang="ts">
import type { FullAutoFill } from "svelte/elements";
import Icon from "#lib/components/Icon.svelte";
import { t } from "#lib/i18n/index.svelte.js";

interface Props {
	id: string;
	value: string;
	placeholder: string;
	invalid?: boolean;
	describedby?: string | undefined;
	autocomplete?: FullAutoFill;
	/** Shows a button that fills the field, with this accessible name. */
	generateLabel?: string;
	ongenerate?: () => void;
}

let {
	id,
	value = $bindable(),
	placeholder,
	invalid = false,
	describedby,
	autocomplete = "off",
	generateLabel,
	ongenerate,
}: Props = $props();

let visible = $state(false);
let input: HTMLInputElement | undefined = $state();

export function focus(): void {
	input?.focus();
}
</script>

<!--
	Password managers treat any password input as a login form: 1Password filled
	this one with saved credentials. These fields hold one-off passwords, so the
	managers are told to leave them alone (data-1p-ignore, LastPass's
	data-lpignore, Bitwarden's data-bwignore, Dashlane's data-form-type).
-->
<div class="relative">
	<input
		{id}
		bind:this={input}
		bind:value
		type={visible ? "text" : "password"}
		class="field"
		class:with-generate={!!ongenerate}
		{placeholder}
		{autocomplete}
		autocapitalize="off"
		spellcheck="false"
		data-1p-ignore
		data-lpignore="true"
		data-bwignore
		data-form-type="other"
		aria-invalid={invalid ? "true" : undefined}
		aria-describedby={describedby}
	/>
	<div class="actions">
		{#if ongenerate && generateLabel}
			<button
				type="button"
				class="btn btn-ghost btn-sm btn-icon"
				aria-label={generateLabel}
				title={generateLabel}
				onclick={() => {
					ongenerate();
					visible = true;
				}}
			>
				<Icon name="refresh" size={15} />
			</button>
		{/if}
		<button
			type="button"
			class="btn btn-ghost btn-sm btn-icon"
			aria-label={t("show_password")}
			title={t("show_password")}
			aria-pressed={visible}
			onclick={() => (visible = !visible)}
		>
			<Icon name={visible ? "eye-off" : "eye"} size={15} />
		</button>
	</div>
</div>

<style>
	.field {
		padding-right: 48px;
	}

	.with-generate {
		padding-right: 84px;
	}

	.actions {
		position: absolute;
		top: 5px;
		right: 5px;
		display: flex;
		gap: 2px;
	}


</style>

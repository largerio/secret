<script lang="ts">
import { t } from "$lib/i18n/index.svelte";

interface Props {
	value: string;
	onchange?: (value: string) => void;
}

let { value = $bindable(""), onchange }: Props = $props();

let length = $state(32);
let uppercase = $state(true);
let lowercase = $state(true);
let digits = $state(true);
let symbols = $state(true);
let copied = $state(false);

const CHARSETS = {
	uppercase: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
	lowercase: "abcdefghijklmnopqrstuvwxyz",
	digits: "0123456789",
	symbols: "!@#$%^&*()-_=+[]{}|;:,.<>?/~`",
};

function uniformRandom(max: number): number {
	const limit = Math.floor(0x100000000 / max) * max;
	const array = new Uint32Array(1);
	for (;;) {
		crypto.getRandomValues(array);
		const val = array[0] ?? 0;
		if (val < limit) return val % max;
	}
}

function generate(): void {
	let charset = "";
	if (uppercase) charset += CHARSETS.uppercase;
	if (lowercase) charset += CHARSETS.lowercase;
	if (digits) charset += CHARSETS.digits;
	if (symbols) charset += CHARSETS.symbols;

	if (charset.length === 0) {
		charset = CHARSETS.lowercase;
	}

	let result = "";
	for (let i = 0; i < length; i++) {
		result += charset[uniformRandom(charset.length)];
	}

	value = result;
	onchange?.(result);
}

async function copyPassword(): Promise<void> {
	try {
		await navigator.clipboard.writeText(value);
		copied = true;
		setTimeout(() => {
			copied = false;
		}, 2000);
	} catch {
		// Silently fail
	}
}
</script>

<div class="space-y-3">
	<div class="flex flex-col gap-2 sm:flex-row">
		<input
			type="text"
			bind:value={value}
			placeholder="••••••••"
			class="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 font-mono text-sm text-white placeholder-slate-500 break-all sm:flex-1"
		/>
		<div class="flex gap-2">
			<button
				type="button"
				onclick={copyPassword}
				disabled={!value}
				class="flex-1 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-300 hover:bg-slate-700 disabled:opacity-50 transition-colors sm:flex-none"
			>
				<i class="fa-regular fa-copy"></i> {copied ? t("password_copied") : t("copy_button")}
			</button>
			<button
				type="button"
				onclick={generate}
				class="flex-1 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark transition-colors sm:flex-none"
			>
				<i class="fa-solid fa-arrows-rotate"></i> {t("generate_password")}
			</button>
		</div>
	</div>

	<div class="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4">
		<label class="flex items-center gap-2 text-sm text-slate-300">
			<span class="text-slate-400">{t("password_length")}</span>
			<input
				type="range"
				bind:value={length}
				min="8"
				max="128"
				class="h-1.5 flex-1 cursor-pointer accent-primary sm:w-24 sm:flex-none"
			/>
			<span class="w-8 text-center font-mono text-xs text-slate-400">{length}</span>
		</label>

		<div class="flex flex-wrap gap-x-4 gap-y-1">
			<label class="flex items-center gap-1.5 text-sm text-slate-300">
				<input
					type="checkbox"
					bind:checked={uppercase}
					class="h-3.5 w-3.5 rounded border-slate-600 bg-slate-800 text-primary focus:ring-primary"
				/>
				{t("password_uppercase")}
			</label>

			<label class="flex items-center gap-1.5 text-sm text-slate-300">
				<input
					type="checkbox"
					bind:checked={lowercase}
					class="h-3.5 w-3.5 rounded border-slate-600 bg-slate-800 text-primary focus:ring-primary"
				/>
				{t("password_lowercase")}
			</label>

			<label class="flex items-center gap-1.5 text-sm text-slate-300">
				<input
					type="checkbox"
					bind:checked={digits}
					class="h-3.5 w-3.5 rounded border-slate-600 bg-slate-800 text-primary focus:ring-primary"
				/>
				{t("password_digits")}
			</label>

			<label class="flex items-center gap-1.5 text-sm text-slate-300">
				<input
					type="checkbox"
					bind:checked={symbols}
					class="h-3.5 w-3.5 rounded border-slate-600 bg-slate-800 text-primary focus:ring-primary"
				/>
				{t("password_symbols")}
			</label>
		</div>
	</div>
</div>

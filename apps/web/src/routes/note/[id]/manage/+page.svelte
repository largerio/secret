<script lang="ts">
import { page } from "$app/state";
import Icon from "$lib/components/Icon.svelte";
import { getClient } from "$lib/client";
import { getConfig } from "$lib/config.svelte";
import { t } from "$lib/i18n/index.svelte";
import { solveCap } from "$lib/utils/cap";

const { data } = $props();

let mounted = $state(false);
let deleteToken = $state("");
let isDeleting = $state(false);
let isDeleted = $state(false);
let error = $state("");

$effect(() => {
	deleteToken = window.location.hash.slice(1);
	mounted = true;
});

const deleteLabel = $derived(
	!mounted ? t("loading") : isDeleting ? t("deleting") : t("delete_button"),
);

async function handleDelete() {
	if (!confirm(t("delete_confirm"))) return;

	const id = page.params["id"];
	if (!id || !deleteToken) return;

	isDeleting = true;
	error = "";
	try {
		const capToken = await solveCap();
		const client = await getClient();
		await client.deleteNote(id, deleteToken, capToken);
		isDeleted = true;
	} catch (e) {
		error = e instanceof Error ? e.message : t("error_generic");
	} finally {
		isDeleting = false;
	}
}
</script>

<svelte:head>
	<title>{getConfig().appName} — {t("manage_title")}</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<div class="space-y-6">
	{#if !data.noteExists && !isDeleted}
		<div
			class="rounded-2xl border p-8 text-center"
			style:background="var(--bg-2)"
			style:border-color="var(--line)"
		>
			<h1 class="serif" style:font-size="24px" style:color="var(--text)">
				{t("not_found_title")}
			</h1>
			<p class="mt-2" style:color="var(--muted)">{t("not_found_description")}</p>
			<a
				href="/"
				class="mt-4 inline-flex items-center gap-2 rounded-lg transition-colors"
				style:background="var(--accent-strong)"
				style:color="var(--accent-ink)"
				style:padding="12px 18px"
				style:font-size="14px"
			>
				<Icon name="lock" size={14} />
				<span>{t("new_note")}</span>
			</a>
		</div>
	{:else if isDeleted}
		<div
			class="rounded-2xl border p-8 text-center"
			style:background="var(--bg-2)"
			style:border-color="var(--line)"
		>
			<p
				class="inline-flex items-center justify-center gap-2"
				style:color="var(--text)"
				style:font-size="17px"
				style:font-weight="500"
			>
				<Icon name="check" size={16} />
				<span>{t("note_deleted")}</span>
			</p>
			<div>
				<a
					href="/"
					class="mt-4 inline-flex items-center gap-2 rounded-lg transition-colors"
					style:background="var(--accent-strong)"
					style:color="var(--accent-ink)"
					style:padding="12px 18px"
					style:font-size="14px"
				>
					<Icon name="lock" size={14} />
					<span>{t("new_note")}</span>
				</a>
			</div>
		</div>
	{:else if mounted && !deleteToken}
		<div
			class="rounded-2xl border p-8 text-center"
			style:background="var(--accent-soft)"
			style:border-color="var(--accent-ring)"
		>
			<h1 style:color="var(--text)" style:font-size="17px" style:font-weight="600">
				{t("error_title")}
			</h1>
			<p class="mt-2" style:color="var(--muted)" style:font-size="14px">
				{t("manage_invalid_token")}
			</p>
			<a
				href="/"
				class="mt-4 inline-flex items-center gap-2 rounded-lg transition-colors"
				style:background="var(--accent-strong)"
				style:color="var(--accent-ink)"
				style:padding="12px 18px"
				style:font-size="14px"
			>
				<Icon name="lock" size={14} />
				<span>{t("new_note")}</span>
			</a>
		</div>
	{:else}
		<div
			class="space-y-4 rounded-2xl border p-6"
			style:background="var(--bg-2)"
			style:border-color="var(--line)"
		>
			<h1 class="serif" style:font-size="24px" style:color="var(--text)">
				{t("manage_title")}
			</h1>
			<p style:color="var(--muted)" style:font-size="14px">{t("manage_description")}</p>

			{#if error}
				<div
					class="rounded-xl border px-4 py-3 text-sm"
					style:background="var(--accent-soft)"
					style:border-color="var(--accent-ring)"
					style:color="var(--text)"
					role="alert"
				>
					{error}
				</div>
			{/if}

			<button
				onclick={handleDelete}
				disabled={!mounted || isDeleting}
				class="inline-flex w-full items-center justify-center gap-2 rounded-xl border px-4 py-3 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
				style:background="var(--accent-soft)"
				style:border-color="var(--accent-ring)"
				style:color="var(--accent)"
			>
				<Icon name="trash" size={14} />
				<span>{deleteLabel}</span>
			</button>
		</div>
	{/if}
</div>

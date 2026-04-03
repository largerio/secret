<script lang="ts">
import { onMount } from "svelte";
import { page } from "$app/state";
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

onMount(() => {
	deleteToken = window.location.hash.slice(1);
	mounted = true;
});

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
		<div class="rounded-xl border border-slate-700 bg-slate-900 p-8 text-center">
			<h1 class="text-xl font-semibold text-slate-300">{t("not_found_title")}</h1>
			<p class="mt-2 text-slate-500">{t("not_found_description")}</p>
			<a href="/" class="mt-4 inline-block rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark transition-colors">
				{t("new_note")}
			</a>
		</div>

	{:else if isDeleted}
		<div class="rounded-xl border border-green-800/50 bg-green-900/20 p-8 text-center">
			<p class="text-lg font-semibold text-green-300">
				<i class="fa-solid fa-check"></i> {t("note_deleted")}
			</p>
			<a href="/" class="mt-4 inline-block rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark transition-colors">
				{t("new_note")}
			</a>
		</div>

	{:else if mounted && !deleteToken}
		<div class="rounded-xl border border-red-800/50 bg-red-900/20 p-8 text-center">
			<h1 class="text-lg font-semibold text-red-300">{t("error_title")}</h1>
			<p class="mt-2 text-sm text-red-400">{t("manage_invalid_token")}</p>
			<a href="/" class="mt-4 inline-block rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark transition-colors">
				{t("new_note")}
			</a>
		</div>

	{:else}
		<div class="rounded-xl border border-slate-700 bg-slate-900 p-6 space-y-4">
			<h1 class="text-xl font-semibold">{t("manage_title")}</h1>
			<p class="text-sm text-slate-400">{t("manage_description")}</p>

			{#if error}
				<div class="rounded-lg border border-red-800/50 bg-red-900/20 px-4 py-3 text-sm text-red-300" role="alert">
					{error}
				</div>
			{/if}

			<button
				onclick={handleDelete}
				disabled={!mounted || isDeleting}
				class="w-full rounded-lg border border-red-800/50 bg-red-900/20 px-4 py-3 text-sm font-medium text-red-300 hover:bg-red-900/40 disabled:opacity-50 transition-colors"
			>
				<i class="fa-solid fa-trash"></i> {!mounted ? t("loading") : isDeleting ? t("deleting") : t("delete_button")}
			</button>
		</div>
	{/if}
</div>

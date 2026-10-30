<script lang="ts">
import { SecretApiError } from "@largerio/secret-sdk";
import { onMount, tick } from "svelte";
import { page } from "$app/state";
import Icon from "#lib/components/Icon.svelte";
import NoticeView from "#lib/components/ui/NoticeView.svelte";
import PageHero from "#lib/components/ui/PageHero.svelte";
import SuccessBadge from "#lib/components/ui/SuccessBadge.svelte";
import { getConfig } from "#lib/config.svelte.js";
import { t } from "#lib/i18n/index.svelte.js";
import { deleteNote } from "#lib/notes/notes.js";
import { solveCap } from "#lib/utils/cap.js";
import { requestErrorMessage } from "#lib/utils/errors.js";
import type { PageData } from "./$types";

const { data }: { data: PageData } = $props();

let mounted = $state(false);
let deleteToken = $state("");
// Deleting is final, so it takes two clicks: the first only asks for confirmation.
let confirming = $state(false);
let isDeleting = $state(false);
let isDeleted = $state(false);
// Expired, read for the last time or deleted since the page loaded.
let gone = $state(false);
let error = $state("");
// The button that replaces the one just clicked takes the focus, so the
// keyboard never falls back to the top of the page.
let deleteButton: HTMLButtonElement | undefined = $state();
let confirmButton: HTMLButtonElement | undefined = $state();

onMount(() => {
	deleteToken = window.location.hash.slice(1);
	mounted = true;
});

async function setConfirming(next: boolean): Promise<void> {
	confirming = next;
	await tick();
	(next ? confirmButton : deleteButton)?.focus();
}

async function handleDelete(): Promise<void> {
	const id = page.params.id;
	if (!id || !deleteToken) return;

	isDeleting = true;
	error = "";
	try {
		const capToken = await solveCap();
		await deleteNote(id, deleteToken, capToken);
		isDeleted = true;
	} catch (e) {
		if (e instanceof SecretApiError && e.status === 404) gone = true;
		// The instance's refusal of the token: a 403 without its code is a
		// firewall's or a proxy's, which the token has nothing to do with.
		else if (e instanceof SecretApiError && e.code === "wrong_delete_token")
			error = t("manage_wrong_token");
		else error = requestErrorMessage(e);
	} finally {
		isDeleting = false;
	}
}
</script>

<svelte:head>
	<title>{getConfig().appName} — {t("manage_title")}</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

{#if isDeleted}
	<PageHero title={t("note_deleted")} sub={t("note_deleted_sub")} afterAction>
		{#snippet badge()}
			<SuccessBadge />
		{/snippet}
	</PageHero>
	<div class="rise flex justify-center" style:animation-delay="0.18s">
		<a href="/" class="btn btn-primary"><Icon name="plus" size={15} />{t("new_note")}</a>
	</div>
{:else if !data.noteExists || gone}
	<NoticeView
		icon="file-x"
		title={t("not_found_title")}
		sub={t("not_found_description")}
		afterAction={gone}
	/>
{:else if mounted && !deleteToken}
	<NoticeView icon="link" title={t("error_title")} sub={t("manage_invalid_token")} />
{:else}
	<PageHero title={t("manage_title")} sub={t("manage_description")} />

	<section
		class="card rise flex flex-col gap-3 p-4"
		style:animation-delay="0.18s"
		aria-label={t("manage_title")}
	>
		{#if error}
			<p class="pop m-0 text-sm text-danger" role="alert">{error}</p>
		{/if}

		{#if confirming}
			<p class="pop m-0 flex items-center gap-2 text-sm text-muted">
				<Icon name="alert" size={16} class="shrink-0 text-danger" />{t("delete_confirm")}
			</p>
			<div class="flex flex-wrap gap-2">
				<button
					type="button"
					class="btn btn-outline flex-1"
					disabled={isDeleting}
					onclick={() => setConfirming(false)}
				>
					{t("cancel")}
				</button>
				<button
					type="button"
					class="btn btn-danger flex-1"
					bind:this={confirmButton}
					disabled={isDeleting}
					onclick={handleDelete}
				>
					<Icon name="trash" size={15} />
					{isDeleting ? t("deleting") : t("delete_confirm_button")}
				</button>
			</div>
		{:else}
			<button
				type="button"
				class="btn btn-outline btn-lg w-full"
				bind:this={deleteButton}
				disabled={!mounted}
				onclick={() => setConfirming(true)}
			>
				<Icon name="trash" size={16} />
				{mounted ? t("delete_button") : t("loading")}
			</button>
		{/if}
	</section>
{/if}

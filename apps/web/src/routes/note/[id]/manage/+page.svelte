<script lang="ts">
import { SecretApiError } from "@largerio/secret-sdk";
import { pageTitle } from "@largerio/secret-shared/site";
import { onMount, tick } from "svelte";
import { page } from "$app/state";
import Icon from "#lib/components/Icon.svelte";
import CheckingView from "#lib/components/ui/CheckingView.svelte";
import NoticeView from "#lib/components/ui/NoticeView.svelte";
import PageHero from "#lib/components/ui/PageHero.svelte";
import SuccessBadge from "#lib/components/ui/SuccessBadge.svelte";
import { getConfig } from "#lib/config.svelte.js";
import { t } from "#lib/i18n/index.svelte.js";
import { type CheckNotice, checkNoteLink, NOTICES } from "#lib/notes/check.js";
import { deleteNote } from "#lib/notes/notes.js";
import { solveCap } from "#lib/utils/cap.js";
import { requestErrorMessage } from "#lib/utils/errors.js";

// Where the note stands: "checking" while the instance is asked, "found" when
// it is there to delete, else why the page has none to offer. An outage or a
// rate limit is no note gone: a creator come to revoke a leaked link would
// leave it readable. The page renders at once, and every screen after that
// first one replaces another, so each one's title takes the focus
// (afterAction): the answer is announced, and the keyboard starts from it.
let standing = $state<"checking" | "found" | CheckNotice>("checking");
let deleteToken = $state("");
// Deleting is final, so it takes two clicks: the first only asks for confirmation.
let confirming = $state(false);
let isDeleting = $state(false);
let isDeleted = $state(false);
let error = $state("");
// The button that replaces the one just clicked takes the focus, so the
// keyboard never falls back to the top of the page.
let deleteButton: HTMLButtonElement | undefined = $state();
let confirmButton: HTMLButtonElement | undefined = $state();

onMount(() => {
	deleteToken = window.location.hash.slice(1);
	let left = false;
	checkNoteLink(page.params.id ?? "").then((check) => {
		if (!left) standing = check.kind === "found" ? "found" : check.notice;
	});
	return () => {
		left = true;
	};
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
		// Expired, read for the last time or deleted since the page loaded.
		if (e instanceof SecretApiError && e.status === 404) standing = "not_found";
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

<!-- The server renders the page's head (noindex included): the title is kept
here, built as the server builds it, so that navigating here sets it. -->
<svelte:head>
	<title>{pageTitle("manage", getConfig().appName, t)}</title>
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
{:else if standing === "checking"}
	<CheckingView />
{:else if standing !== "found"}
	{@const notice = NOTICES[standing]}
	<NoticeView icon={notice.icon} title={t(notice.title)} sub={t(notice.body)} afterAction />
{:else if !deleteToken}
	<NoticeView icon="link" title={t("error_title")} sub={t("manage_invalid_token")} afterAction />
{:else}
	<PageHero title={t("manage_title")} sub={t("manage_description")} afterAction />

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
				onclick={() => setConfirming(true)}
			>
				<Icon name="trash" size={16} />
				{t("delete_button")}
			</button>
		{/if}
	</section>
{/if}

<script lang="ts">
import { SecretApiError, SecretDecryptionError } from "@largerio/secret-sdk";
import { pageTitle } from "@largerio/secret-shared/site";
import { flushSync, onMount, tick } from "svelte";
import { page } from "$app/state";
import Icon from "#lib/components/Icon.svelte";
import FileRow from "#lib/components/note/FileRow.svelte";
import NoteContent from "#lib/components/note/NoteContent.svelte";
import Callout from "#lib/components/ui/Callout.svelte";
import CheckingView from "#lib/components/ui/CheckingView.svelte";
import NoticeView from "#lib/components/ui/NoticeView.svelte";
import PageHero from "#lib/components/ui/PageHero.svelte";
import PasswordField from "#lib/components/ui/PasswordField.svelte";
import ProgressPanel from "#lib/components/ui/ProgressPanel.svelte";
import TrustLine from "#lib/components/ui/TrustLine.svelte";
import { getConfig } from "#lib/config.svelte.js";
import { formatDateTime, t, tn } from "#lib/i18n/index.svelte.js";
import { checkNoteLink, type LinkNotice, NOTICES, type NoteSummary } from "#lib/notes/check.js";
import { type OpenedNote, readNote } from "#lib/notes/notes.js";
import { onBackForwardCache } from "#lib/utils/backForwardCache.js";
import { isUnreachable, requestErrorMessage } from "#lib/utils/errors.js";
import { renderMarkdown } from "#lib/utils/markdown.js";
import { type ProgressView, readProgress } from "#lib/utils/progress.js";
import {
	attemptsLeft,
	isLastRead,
	type ReadsAfter,
	readsAfter,
	readsBefore,
	readsLeft,
} from "#lib/utils/reads.js";
import { isKeyFragment, keyAfterHashChange } from "#lib/utils/shareUrl.js";

type NoteStatus =
	| { state: "checking" }
	| { state: "notice"; notice: LinkNotice }
	| { state: "ready"; info: NoteSummary }
	| { state: "opening"; progress: ProgressView }
	| { state: "revealed"; note: OpenedNote; urls: string[]; after: ReadsAfter }
	| { state: "error"; message: string };

// The page renders at once and asks the instance where the note stands; from
// its answer on, the reader drives it. Every screen after the first replaces
// another, so each one's title takes the focus (afterAction): the answer is
// announced, and the keyboard starts from it.
let status = $state<NoteStatus>({ state: "checking" });
// The note as the check found it, null until then or if it found none.
let checked = $state<NoteSummary | null>(null);
let keyFragment = $state("");
let password = $state("");
let passwordProblem = $state<"" | "empty" | "wrong">("");
let wrongMessage = $state("");
let passwordField: PasswordField | undefined = $state();
let renderedMarkdown = $state("");
// Left before a read ended, the page lets go of the note it gets.
let destroyed = false;

// From the check, not from `status`: a failed read is handled once `status`
// has moved on, and that path must still know the note was single-read —
// otherwise it offers a retry on a note that no longer exists.
const isBurn = $derived(checked?.maxReads === 1);

const openingLabel = $derived(
	status.state === "opening" && status.progress.step === 0
		? t("read_downloading", { percent: status.progress.percent ?? 0 })
		: t("read_decrypting"),
);

const revealedSub = $derived.by(() => {
	if (status.state !== "revealed") return "";
	const { after } = status;
	if (after.kind === "gone") {
		return status.note.contentMode === "secret" ? t("rv_sub_secret_gone") : t("rv_sub_gone");
	}
	if (after.kind === "left") return tn("rv_sub_left", after.count);
	return after.kind === "limited" ? t("rv_sub_limited") : "";
});

$effect(() => {
	if (status.state !== "revealed" || status.note.contentMode !== "markdown") {
		renderedMarkdown = "";
		return;
	}
	const source = status.note.text ?? "";
	let cancelled = false;
	renderMarkdown(source).then((html) => {
		if (!cancelled) renderedMarkdown = html;
	});
	return () => {
		cancelled = true;
	};
});

/** Where the page starts once the instance has answered. */
async function check(id: string): Promise<void> {
	const result = await checkNoteLink(id);
	if (destroyed) return;
	if (result.kind === "notice") {
		status = { state: "notice", notice: result.notice };
		return;
	}
	checked = result.note;
	// A missing or cut fragment means the link was truncated in transit (mail
	// clients, chat apps and SMS linkifiers all do it), not that the note is
	// gone. Caught here, before any read: the server spends a read before the
	// key is ever used, so a broken key would burn reads on every attempt.
	status = isKeyFragment(keyFragment)
		? { state: "ready", info: result.note }
		: { state: "notice", notice: "link_incomplete" };
}

onMount(() => {
	keyFragment = window.location.hash.slice(1);
	void check(page.params["id"] ?? "");

	// The full link pasted into the same tab only changes the fragment: the
	// page does not reload, so pick the key up from here. Only a key, though:
	// an in-page anchor's fragment once replaced a key that worked.
	const onHashChange = () => {
		keyFragment = keyAfterHashChange(keyFragment, window.location.hash);
		const incomplete = status.state === "notice" && status.notice === "link_incomplete";
		if (incomplete && checked && isKeyFragment(keyFragment)) {
			status = { state: "ready", info: checked };
		}
	};
	window.addEventListener("hashchange", onHashChange);

	// Back would show the note again, read or not: the page forgets it as it
	// is put away, and reloads on the way back to show where the note stands.
	const stopCaching = onBackForwardCache(
		() =>
			flushSync(() => {
				forgetNote();
				status = { state: "checking" };
				password = "";
			}),
		() => location.reload(),
	);

	return () => {
		destroyed = true;
		window.removeEventListener("hashchange", onHashChange);
		stopCaching();
		forgetNote();
	};
});

/** Lets go of a note read: its files' URLs, then the files, on disk or in memory. */
function forgetNote(): void {
	if (status.state !== "revealed") return;
	for (const url of status.urls) URL.revokeObjectURL(url);
	void status.note.close();
}

function readsText(info: NoteSummary): string {
	const reads = readsBefore(info.maxReads, info.readCount);
	if (reads.kind === "left") return tn("un_reads_left", reads.count);
	return reads.kind === "total" ? tn("un_reads_total", reads.count) : "";
}

/**
 * Ask the server where the note stands, rather than work it out locally:
 * other readers may have spent reads since the page loaded. Null when the
 * server cannot tell.
 */
async function recheck(id: string): Promise<NoteSummary | "gone" | null> {
	const now = await checkNoteLink(id);
	if (now.kind === "found") return now.note;
	return now.notice === "not_found" ? "gone" : null;
}

function attemptsText(left: number | null): string {
	const attempts = attemptsLeft(left);
	if (attempts.kind === "none") return "";
	return attempts.kind === "last" ? t("un_pw_attempt_last") : tn("un_pw_attempts", attempts.count);
}

async function failPassword(id: string, current: NoteSummary): Promise<void> {
	if (current.format === 1) {
		await failProof(id, current);
		return;
	}
	// The server cannot check a format 0 note's password (it never sees the
	// key), so the read was spent the moment the ciphertext was served.
	// Offering a retry on a burn-after-read note would be a lie: it is already gone.
	if (isBurn) {
		status = { state: "error", message: t("error_burned_wrong_password") };
		return;
	}

	const fresh = await recheck(id);
	if (fresh === "gone") {
		status = { state: "error", message: t("error_wrong_password_last") };
		return;
	}

	const info = { ...current, readCount: fresh?.readCount ?? null };
	const left = readsLeft(info.maxReads, info.readCount);
	wrongMessage = left === null ? t("error_wrong_password") : tn("error_wrong_password_left", left);
	passwordProblem = "wrong";
	status = { state: "ready", info };
	await tick();
	passwordField?.focus();
}

/**
 * A format 1 note's server checked a proof of the password before serving
 * anything: no read was spent, an attempt was, and the last one deletes it.
 */
async function failProof(id: string, current: NoteSummary): Promise<void> {
	const fresh = await recheck(id);
	if (fresh === "gone") {
		status = { state: "error", message: t("error_wrong_password_exhausted") };
		return;
	}

	const left = fresh?.passwordAttemptsLeft ?? null;
	const attempts = attemptsLeft(left);
	wrongMessage =
		attempts.kind === "none"
			? t("error_wrong_password_proof")
			: attempts.kind === "last"
				? t("error_wrong_password_attempt_last")
				: tn("error_wrong_password_attempts", attempts.count);
	passwordProblem = "wrong";
	status = {
		state: "ready",
		info: {
			...current,
			readCount: fresh ? fresh.readCount : current.readCount,
			passwordAttemptsLeft: left,
		},
	};
	await tick();
	passwordField?.focus();
}

async function handleOpen(): Promise<void> {
	const id = page.params["id"];
	if (!id || status.state !== "ready") return;
	const current = status.info;

	if (current.hasPassword && !password) {
		passwordProblem = "empty";
		passwordField?.focus();
		return;
	}

	passwordProblem = "";
	status = { state: "opening", progress: { step: 0, percent: 0, chunk: null } };

	try {
		const note = await readNote(id, keyFragment, {
			...(password ? { password } : {}),
			chunked: current.chunked,
			onProgress: (info) => {
				if (status.state === "opening") status = { state: "opening", progress: readProgress(info) };
			},
		});

		if (destroyed) {
			void note.close();
			return;
		}
		// One URL per file, for its preview and its download, until the page lets go of the note.
		const urls = note.files.map((file) => URL.createObjectURL(file.data));
		// A single-read note is gone without asking.
		const after = readsAfter(current.maxReads, isBurn ? null : await recheck(id));
		status = { state: "revealed", note, urls, after };
	} catch (e) {
		if (e instanceof SecretApiError && e.status === 404) {
			// Someone else spent the last read in the meantime.
			status = { state: "notice", notice: "not_found" };
		} else if (e instanceof SecretApiError && e.status === 429) {
			status = { state: "notice", notice: "rate_limited" };
		} else if (e instanceof SecretDecryptionError && current.hasPassword) {
			// A wrong password, or a damaged key: which of them cannot be told, by design.
			await failPassword(id, current);
		} else if (isUnreachable(e)) {
			// The server may have counted the read before the failure.
			const fresh = await recheck(id);
			status = { state: "notice", notice: fresh === "gone" ? "not_found" : "unavailable" };
		} else if (e instanceof SecretApiError) {
			status = { state: "error", message: requestErrorMessage(e) };
		} else {
			status = { state: "error", message: t("error_decryption") };
		}
	}
}
</script>

<!-- The server renders the page's head (noindex included) for crawlers and
link previews: the title is kept here, built as the server builds it, so that
navigating here sets it. -->
<svelte:head>
	<title>{pageTitle("note", getConfig().appName, t)}</title>
</svelte:head>

{#if status.state === "checking"}
	<CheckingView />
{:else if status.state === "ready"}
	{@const info = status.info}
	{@const lastRead = isLastRead(info.maxReads, info.readCount)}
	{@const reads = isBurn ? "" : readsText(info)}
	{@const attempts = info.format === 1 ? attemptsText(info.passwordAttemptsLeft) : ""}
	<PageHero title={t("un_title")} sub={t("un_sub")} afterAction />

	<form
		class="card rise"
		style:animation-delay="0.18s"
		aria-label={t("un_title")}
		onsubmit={(event) => {
			event.preventDefault();
			handleOpen();
		}}
	>
		{#if lastRead}
			<div class="px-3 pt-3">
				<Callout tone="warn" icon="flame" title={isBurn ? t("un_burn_title") : t("un_last_title")}>
					{t("un_burn_body")}
					{#if info.hasPassword && info.format === 0}
						<span class="mt-0.5 block font-medium text-warn">{t("burn_password_warning")}</span>
					{/if}
				</Callout>
			</div>
		{/if}

		<ul class="m-0 flex list-none flex-col gap-2.5 px-[18px] py-4 text-sm text-muted">
			{#if reads}
				<li class="flex items-center gap-2.5">
					<Icon name="eye" size={16} class="text-accent-text" />{reads}
				</li>
			{/if}
			<li class="flex items-center gap-2.5">
				<Icon name="clock" size={16} class="text-accent-text" />{t("un_expiry", {
					date: formatDateTime(info.expiresAt),
				})}
			</li>
			{#if info.fileCount > 0}
				<li class="flex items-center gap-2.5">
					<Icon name="paperclip" size={16} class="text-accent-text" />{tn("files_count", info.fileCount)}
				</li>
			{/if}
		</ul>

		{#if info.hasPassword}
			<div class="flex flex-col gap-1.5 px-[18px] pb-4">
				<label for="decrypt-password" class="text-[13px] font-medium">
					{t("un_pw_label")} <span class="font-normal text-faint">— {t("un_pw_hint")}</span>
				</label>
				<PasswordField
					bind:this={passwordField}
					id="decrypt-password"
					bind:value={password}
					placeholder={t("un_pw_placeholder")}
					invalid={passwordProblem !== ""}
					describedby={passwordProblem
						? "decrypt-password-error"
						: attempts
							? "decrypt-password-attempts"
							: undefined}
				/>
				{#if passwordProblem}
					<p
						id="decrypt-password-error"
						class="pop m-0 mt-0.5 flex items-start gap-2 text-[13px] text-danger"
						role="alert"
					>
						<Icon name="alert" size={15} class="mt-0.5 shrink-0" />
						{passwordProblem === "empty" ? t("un_pw_empty") : wrongMessage}
					</p>
				{:else if attempts}
					<p id="decrypt-password-attempts" class="m-0 mt-0.5 text-[13px] text-warn">{attempts}</p>
				{/if}
			</div>
		{/if}

		<div class="border-t border-line p-3">
			<button type="submit" class="btn btn-primary btn-lg w-full">
				<Icon name="unlock" size={16} />
				{info.hasPassword ? t("un_unlock") : t("un_show")}
			</button>
		</div>
	</form>

	<div class="rise" style:animation-delay="0.3s"><TrustLine /></div>
{:else if status.state === "notice"}
	{@const notice = NOTICES[status.notice]}
	<NoticeView icon={notice.icon} title={t(notice.title)} sub={t(notice.body)} afterAction />
{:else if status.state === "opening"}
	<PageHero title={t("un_title")} sub={t("un_sub")} afterAction />
	<ProgressPanel
		view={status.progress}
		label={openingLabel}
		detail={t("key_stays_here")}
		steps={[t("step_download"), t("step_decrypt"), t("step_note")]}
	/>
	<TrustLine />
{:else if status.state === "revealed"}
	{@const note = status.note}
	{@const files = note.files}
	<PageHero
		title={note.contentMode === "secret" ? t("rv_title_secret") : t("rv_title")}
		sub={revealedSub || undefined}
		afterAction
	/>

	{#if note.text}
		<NoteContent text={note.text} mode={note.contentMode ?? "text"} html={renderedMarkdown} />
	{/if}

	{#if files.length > 0}
		<section class="panel pop flex flex-col gap-2 p-3" aria-labelledby="files-label">
			<p id="files-label" class="m-0 px-1.5 text-xs font-medium text-faint">
				{tn("files_count", files.length)}
			</p>
			<ul class="m-0 flex list-none flex-col gap-2 p-0">
				{#each files as file, index (file.name + index)}
					<FileRow name={file.name} type={file.type} size={file.size} url={status.urls[index] ?? ""} />
				{/each}
			</ul>
		</section>
	{/if}

	<div class="flex justify-center">
		<a href="/" class="btn btn-outline"><Icon name="plus" size={15} />{t("rv_new")}</a>
	</div>
{:else}
	<NoticeView icon="alert" title={t("error_title")} sub={status.message} afterAction />
{/if}

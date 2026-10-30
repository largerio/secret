<script lang="ts">
import { SecretApiError, SecretDecryptionError } from "@largerio/secret-sdk";
import type { NotePayload } from "@largerio/secret-shared";
import { flushSync, onMount, tick } from "svelte";
import { page } from "$app/state";
import Icon, { type IconName } from "#lib/components/Icon.svelte";
import FileRow from "#lib/components/note/FileRow.svelte";
import NoteContent from "#lib/components/note/NoteContent.svelte";
import Callout from "#lib/components/ui/Callout.svelte";
import NoticeView from "#lib/components/ui/NoticeView.svelte";
import PageHero from "#lib/components/ui/PageHero.svelte";
import PasswordField from "#lib/components/ui/PasswordField.svelte";
import ProgressPanel from "#lib/components/ui/ProgressPanel.svelte";
import TrustLine from "#lib/components/ui/TrustLine.svelte";
import { getClient } from "#lib/client.js";
import { getConfig } from "#lib/config.svelte.js";
import { formatDateTime, type MessageKey, t, tn } from "#lib/i18n/index.svelte.js";
import { onBackForwardCache } from "#lib/utils/backForwardCache.js";
import { isUnreachable, requestErrorMessage } from "#lib/utils/errors.js";
import { isPreviewable } from "#lib/utils/fileType.js";
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
import { isKeyFragment } from "#lib/utils/shareUrl.js";
import type { PageData } from "./$types";

type NoteInfo = NonNullable<PageData["noteInfo"]>;

type Notice = "not_found" | "link_incomplete" | "unavailable" | "rate_limited";

/** Where the note stands, as the server reports it now. */
type NoteNow =
	| { readonly exists: false }
	| {
			readonly exists: true;
			readonly readCount: number | null;
			readonly passwordAttemptsLeft: number | null;
	  };

type NoteStatus =
	| { state: "notice"; notice: Notice }
	| { state: "ready"; info: NoteInfo }
	| { state: "opening"; progress: ProgressView }
	| { state: "revealed"; payload: NotePayload; previewUrls: string[]; after: ReadsAfter }
	| { state: "error"; message: string };

const NOTICES: Record<Notice, { title: MessageKey; body: MessageKey; icon: IconName }> = {
	not_found: { title: "not_found_title", body: "not_found_description", icon: "file-x" },
	link_incomplete: {
		title: "link_incomplete_title",
		body: "link_incomplete_description",
		icon: "link",
	},
	unavailable: { title: "unavailable_title", body: "unavailable_description", icon: "alert" },
	rate_limited: { title: "rate_limited_title", body: "rate_limited_description", icon: "clock" },
};

const { data }: { data: PageData } = $props();

// The page starts from what the loader found; from there on, the reader drives it.
function initialStatus(): NoteStatus {
	if (data.noteInfo) return { state: "ready", info: data.noteInfo };
	const notice = data.unavailable ? "unavailable" : data.rateLimited ? "rate_limited" : "not_found";
	return { state: "notice", notice };
}

let status = $state<NoteStatus>(initialStatus());
let mounted = $state(false);
// Once the reader has acted, each new screen takes the focus.
let acted = $state(false);
let keyFragment = $state("");
let password = $state("");
let passwordProblem = $state<"" | "empty" | "wrong">("");
let wrongMessage = $state("");
let passwordField: PasswordField | undefined = $state();
let renderedMarkdown = $state("");

// From the loader, not from `status`: a failed read is handled once `status`
// has moved on, and that path must still know the note was single-read —
// otherwise it offers a retry on a note that no longer exists.
const isBurn = $derived(data.noteInfo?.maxReads === 1);

const openingLabel = $derived(
	status.state === "opening" && status.progress.step === 0
		? t("read_downloading", { percent: status.progress.percent ?? 0 })
		: t("read_decrypting"),
);

const revealedSub = $derived.by(() => {
	if (status.state !== "revealed") return "";
	const { after } = status;
	if (after.kind === "gone") {
		return status.payload.contentMode === "secret" ? t("rv_sub_secret_gone") : t("rv_sub_gone");
	}
	if (after.kind === "left") return tn("rv_sub_left", after.count);
	return after.kind === "limited" ? t("rv_sub_limited") : "";
});

$effect(() => {
	if (status.state !== "revealed" || status.payload.contentMode !== "markdown") {
		renderedMarkdown = "";
		return;
	}
	const source = status.payload.text ?? "";
	let cancelled = false;
	renderMarkdown(source).then((html) => {
		if (!cancelled) renderedMarkdown = html;
	});
	return () => {
		cancelled = true;
	};
});

onMount(() => {
	keyFragment = window.location.hash.slice(1);
	mounted = true;

	// A missing or cut fragment means the link was truncated in transit (mail
	// clients, chat apps and SMS linkifiers all do it), not that the note is
	// gone. Caught here, before any read: the server spends a read before the
	// key is ever used, so a broken key would burn reads on every attempt.
	if (status.state === "ready" && !isKeyFragment(keyFragment)) {
		status = { state: "notice", notice: "link_incomplete" };
	}

	// The full link pasted into the same tab only changes the fragment: the
	// page does not reload, so pick the key up from here.
	const onHashChange = () => {
		keyFragment = window.location.hash.slice(1);
		const incomplete = status.state === "notice" && status.notice === "link_incomplete";
		if (incomplete && data.noteInfo && isKeyFragment(keyFragment)) {
			status = { state: "ready", info: data.noteInfo };
		}
	};
	window.addEventListener("hashchange", onHashChange);

	// Back would show the note again, read or not: the page forgets it as it
	// is put away, and reloads on the way back to show where the note stands.
	const stopCaching = onBackForwardCache(
		() =>
			flushSync(() => {
				forgetPreviews();
				status = initialStatus();
				password = "";
			}),
		() => location.reload(),
	);

	return () => {
		window.removeEventListener("hashchange", onHashChange);
		stopCaching();
		forgetPreviews();
	};
});

function forgetPreviews(): void {
	if (status.state !== "revealed") return;
	for (const url of status.previewUrls) URL.revokeObjectURL(url);
}

function readsText(info: NoteInfo): string {
	const reads = readsBefore(info.maxReads, info.readCount);
	if (reads.kind === "left") return tn("un_reads_left", reads.count);
	return reads.kind === "total" ? tn("un_reads_total", reads.count) : "";
}

/**
 * Ask the server where the note stands, rather than work it out locally:
 * other readers may have spent reads since the page loaded. Null when the
 * server cannot be asked.
 */
async function recheck(id: string): Promise<NoteNow | null> {
	try {
		const info = await (await getClient()).checkNote(id);
		return info.exists
			? {
					exists: true,
					readCount: info.readCount ?? null,
					passwordAttemptsLeft: info.passwordAttemptsLeft ?? null,
				}
			: { exists: false };
	} catch {
		return null;
	}
}

function attemptsText(left: number | null): string {
	const attempts = attemptsLeft(left);
	if (attempts.kind === "none") return "";
	return attempts.kind === "last" ? t("un_pw_attempt_last") : tn("un_pw_attempts", attempts.count);
}

async function failPassword(id: string, current: NoteInfo): Promise<void> {
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
	if (fresh?.exists === false) {
		status = { state: "error", message: t("error_wrong_password_last") };
		return;
	}

	const info = { ...current, readCount: fresh ? fresh.readCount : null };
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
async function failProof(id: string, current: NoteInfo): Promise<void> {
	const fresh = await recheck(id);
	if (fresh?.exists === false) {
		status = { state: "error", message: t("error_wrong_password_exhausted") };
		return;
	}

	const left = fresh ? fresh.passwordAttemptsLeft : null;
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
	acted = true;
	status = { state: "opening", progress: { step: 0, percent: 0, chunk: null } };

	try {
		const client = await getClient();
		const { payload } = await client.readNote(id, keyFragment, {
			...(password ? { password } : {}),
			chunked: current.chunked,
			onProgress: (info) => {
				if (status.state === "opening") status = { state: "opening", progress: readProgress(info) };
			},
		});

		const previewUrls = (payload.files ?? []).map((file) =>
			isPreviewable(file.type)
				? URL.createObjectURL(new Blob([file.data] as BlobPart[], { type: file.type }))
				: "",
		);
		// A single-read note is gone without asking.
		const after = readsAfter(current.maxReads, isBurn ? null : await recheck(id));
		status = { state: "revealed", payload, previewUrls, after };
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
			status = { state: "notice", notice: fresh?.exists === false ? "not_found" : "unavailable" };
		} else if (e instanceof SecretApiError) {
			status = { state: "error", message: requestErrorMessage(e) };
		} else {
			status = { state: "error", message: t("error_decryption") };
		}
	}
}
</script>

<svelte:head>
	<title>{getConfig().appName} — {t("view_title")}</title>
	<meta name="robots" content="noindex, nofollow" />
	<meta name="description" content={t("view_description")} />
	<meta property="og:title" content="{getConfig().appName} — {t("view_title")}" />
	<meta property="og:description" content={t("view_description")} />
</svelte:head>

{#if status.state === "notice"}
	{@const notice = NOTICES[status.notice]}
	<NoticeView icon={notice.icon} title={t(notice.title)} sub={t(notice.body)} afterAction={acted} />
{:else if status.state === "ready"}
	{@const info = status.info}
	{@const lastRead = isLastRead(info.maxReads, info.readCount)}
	{@const reads = isBurn ? "" : readsText(info)}
	{@const attempts = info.format === 1 ? attemptsText(info.passwordAttemptsLeft) : ""}
	<PageHero title={t("un_title")} sub={t("un_sub")} />

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
			<button type="submit" class="btn btn-primary btn-lg w-full" disabled={!mounted}>
				<Icon name="unlock" size={16} />
				{info.hasPassword ? t("un_unlock") : t("un_show")}
			</button>
		</div>
	</form>

	<div class="rise" style:animation-delay="0.3s"><TrustLine /></div>
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
	{@const payload = status.payload}
	{@const files = payload.files ?? []}
	<PageHero
		title={payload.contentMode === "secret" ? t("rv_title_secret") : t("rv_title")}
		sub={revealedSub || undefined}
		afterAction
	/>

	{#if payload.text}
		<NoteContent text={payload.text} mode={payload.contentMode ?? "text"} html={renderedMarkdown} />
	{/if}

	{#if files.length > 0}
		<section class="panel pop flex flex-col gap-2 p-3" aria-labelledby="files-label">
			<p id="files-label" class="m-0 px-1.5 text-xs font-medium text-faint">
				{tn("files_count", files.length)}
			</p>
			<ul class="m-0 flex list-none flex-col gap-2 p-0">
				{#each files as file, index (file.name + index)}
					<FileRow
						name={file.name}
						type={file.type}
						size={file.size}
						data={file.data}
						previewUrl={status.previewUrls[index] ?? ""}
					/>
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

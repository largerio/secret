<script lang="ts">
import { SecretDecryptionError } from "@largerio/secret-sdk";
import type { NotePayload } from "@largerio/secret-shared";
import { onMount, tick } from "svelte";
import { page } from "$app/state";
import Icon, { type IconName } from "#lib/components/Icon.svelte";
import FileRow from "#lib/components/note/FileRow.svelte";
import NoteContent from "#lib/components/note/NoteContent.svelte";
import Callout from "#lib/components/ui/Callout.svelte";
import NoticeIcon from "#lib/components/ui/NoticeIcon.svelte";
import PageHero from "#lib/components/ui/PageHero.svelte";
import PasswordField from "#lib/components/ui/PasswordField.svelte";
import ProgressPanel from "#lib/components/ui/ProgressPanel.svelte";
import TrustLine from "#lib/components/ui/TrustLine.svelte";
import { getClient } from "#lib/client.js";
import { getConfig } from "#lib/config.svelte.js";
import { formatDateTime, type MessageKey, t, tn } from "#lib/i18n/index.svelte.js";
import { isPreviewable } from "#lib/utils/fileType.js";
import { renderMarkdown } from "#lib/utils/markdown.js";
import { type ProgressView, readProgress } from "#lib/utils/progress.js";
import { readsLeft } from "#lib/utils/reads.js";

interface NoteInfo {
	hasPassword: boolean;
	maxReads: number;
	/** Null when the instance does not report it. */
	readCount: number | null;
	fileCount: number;
	expiresAt: string;
	chunked: boolean;
}

type Notice = "not_found" | "link_incomplete" | "unavailable" | "rate_limited";

type NoteStatus =
	| { state: "notice"; notice: Notice }
	| { state: "ready"; info: NoteInfo }
	| { state: "opening"; progress: ProgressView }
	| { state: "revealed"; payload: NotePayload; previewUrls: string[] }
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

const { data } = $props();

// The page starts from what the loader found; from there on, the reader drives it.
function initialStatus(): NoteStatus {
	if (data.noteInfo) return { state: "ready", info: data.noteInfo };
	const notice = data.unavailable ? "unavailable" : data.rateLimited ? "rate_limited" : "not_found";
	return { state: "notice", notice };
}

let status = $state<NoteStatus>(initialStatus());
let mounted = $state(false);
let keyFragment = $state("");
let password = $state("");
let passwordProblem = $state<"" | "empty" | "wrong">("");
let wrongMessage = $state("");
let passwordField: PasswordField | undefined = $state();
// The note as it stood when it was opened, for what the revealed page says about it.
let openedInfo = $state<NoteInfo | null>(null);
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
	if (status.state !== "revealed" || !openedInfo) return "";
	const secret = status.payload.contentMode === "secret";
	const left = readsLeft(openedInfo.maxReads, openedInfo.readCount);
	const after = left === null ? null : left - 1;
	if (isBurn || after === 0) return secret ? t("rv_sub_secret_gone") : t("rv_sub_gone");
	if (after === null) return openedInfo.maxReads > 0 ? t("rv_sub_limited") : "";
	return tn("rv_sub_left", after);
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

	// A missing fragment means the link was truncated in transit (mail clients,
	// chat apps and SMS linkifiers all do it), not that the note is gone —
	// saying "not found" sent people looking for the wrong problem.
	if (!keyFragment && status.state === "ready") {
		status = { state: "notice", notice: "link_incomplete" };
	}

	return () => {
		if (status.state === "revealed") {
			for (const url of status.previewUrls) URL.revokeObjectURL(url);
		}
	};
});

function readsLeftText(info: NoteInfo): string {
	const left = readsLeft(info.maxReads, info.readCount);
	if (left === null) return info.maxReads > 0 ? t("un_reads_total", { count: info.maxReads }) : "";
	return tn("un_reads_left", left);
}

/**
 * Ask the server where the note stands after a failed attempt, rather than
 * subtract locally: someone else may have read it in the meantime.
 */
async function recheck(id: string, current: NoteInfo): Promise<NoteInfo | "gone"> {
	try {
		const info = await (await getClient()).checkNote(id);
		if (!info.exists) return "gone";
		return { ...current, readCount: info.readCount ?? null, expiresAt: info.expiresAt };
	} catch {
		return { ...current, readCount: null };
	}
}

async function failPassword(id: string, current: NoteInfo): Promise<void> {
	// The server cannot check the password (it never sees the key), so the
	// read was spent the moment the ciphertext was served. Offering a retry on
	// a burn-after-read note would be a lie: it is already gone.
	if (isBurn) {
		status = { state: "error", message: t("error_burned_wrong_password") };
		return;
	}

	const fresh = await recheck(id, current);
	if (fresh === "gone") {
		status = { state: "error", message: t("error_wrong_password_last") };
		return;
	}

	const left = readsLeft(fresh.maxReads, fresh.readCount);
	wrongMessage = left === null ? t("error_wrong_password") : tn("error_wrong_password_left", left);
	passwordProblem = "wrong";
	status = { state: "ready", info: fresh };
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
	openedInfo = current;
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
				? URL.createObjectURL(
						new Blob([new Uint8Array(file.data as ArrayLike<number>)] as BlobPart[], {
							type: file.type,
						}),
					)
				: "",
		);
		status = { state: "revealed", payload, previewUrls };
	} catch (e) {
		// A decryption failure (wrong password or key, corrupted data) surfaces as
		// one typed error — which of them cannot be told, by design.
		if (e instanceof SecretDecryptionError && current.hasPassword) {
			await failPassword(id, current);
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
	<PageHero title={t(notice.title)} sub={t(notice.body)}>
		{#snippet lead()}
			<NoticeIcon name={notice.icon} />
		{/snippet}
	</PageHero>
	<div class="rise flex justify-center" style:animation-delay="0.18s">
		<a href="/" class="btn btn-primary"><Icon name="plus" size={15} />{t("new_note")}</a>
	</div>
{:else if status.state === "ready"}
	{@const info = status.info}
	{@const readsText = isBurn ? "" : readsLeftText(info)}
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
		{#if isBurn}
			<div class="px-3 pt-3">
				<Callout tone="warn" icon="flame" title={t("un_burn_title")}>
					{t("un_burn_body")}
					{#if info.hasPassword}
						<span class="mt-0.5 block font-medium text-warn">{t("burn_password_warning")}</span>
					{/if}
				</Callout>
			</div>
		{/if}

		<ul class="m-0 flex list-none flex-col gap-2.5 px-[18px] py-4 text-sm text-muted">
			{#if readsText}
				<li class="flex items-center gap-2.5">
					<Icon name="eye" size={16} class="text-accent-text" />{readsText}
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
					describedby={passwordProblem ? "decrypt-password-error" : undefined}
				/>
				{#if passwordProblem}
					<p id="decrypt-password-error" class="pop m-0 mt-0.5 flex items-start gap-2 text-[13px] text-danger" role="alert">
						<Icon name="alert" size={15} class="mt-0.5 shrink-0" />
						{passwordProblem === "empty" ? t("un_pw_empty") : wrongMessage}
					</p>
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
	<PageHero title={t("un_title")} sub={t("un_sub")} />
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
						data={new Uint8Array(file.data as ArrayLike<number>)}
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
	<PageHero title={t("error_title")} sub={status.message}>
		{#snippet lead()}
			<NoticeIcon name="alert" />
		{/snippet}
	</PageHero>
	<div class="rise flex justify-center" style:animation-delay="0.18s">
		<a href="/" class="btn btn-primary"><Icon name="plus" size={15} />{t("new_note")}</a>
	</div>
{/if}


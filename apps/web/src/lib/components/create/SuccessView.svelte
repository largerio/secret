<script lang="ts">
import { EXPIRATION_OPTIONS } from "@largerio/secret-shared";
import Icon from "#lib/components/Icon.svelte";
import PageHero from "#lib/components/ui/PageHero.svelte";
import QrCode from "#lib/components/ui/QrCode.svelte";
import SuccessBadge from "#lib/components/ui/SuccessBadge.svelte";
import { getConfig } from "#lib/config.svelte.js";
import { t, tn } from "#lib/i18n/index.svelte.js";
import { splitTemplate } from "#lib/i18n/template.js";
import { copyWithFeedback } from "#lib/utils/clipboard.js";

interface Props {
	shareUrl: string;
	manageUrl: string;
	/** The opening password the note was sent with, empty when none. */
	password: string;
	fileCount: number;
	expiresIn: number;
	maxReads: number;
	onreset: () => void;
	/** Fired once the share link has been copied, so the page can drop its unload guard. */
	onlinkcopied: () => void;
}

const {
	shareUrl,
	manageUrl,
	password,
	fileCount,
	expiresIn,
	maxReads,
	onreset,
	onlinkcopied,
}: Props = $props();

let linkCopied = $state(false);
let passwordCopied = $state(false);
let manageCopied = $state(false);
let passwordVisible = $state(false);
let qrOpen = $state(false);
let clipboardError = $state(false);

const mailto = $derived(
	`mailto:?subject=${encodeURIComponent(getConfig().appName)}&body=${encodeURIComponent(shareUrl)}`,
);

// The fragment is the decryption key: shown apart so it reads as the part that stays secret.
const parts = $derived.by(() => {
	const hash = shareUrl.indexOf("#");
	const base = hash < 0 ? shareUrl : shareUrl.slice(0, hash);
	const scheme = base.indexOf("://") + 3;
	return {
		scheme: base.slice(0, scheme),
		address: base.slice(scheme),
		key: hash < 0 ? "" : shareUrl.slice(hash),
	};
});

const rule = $derived(splitTemplate(t("ok_rule")));
const readsText = $derived(tn("reads_count", maxReads));
const expiryText = $derived(
	t(EXPIRATION_OPTIONS.find((option) => option.value === expiresIn)?.labelKey ?? "expiry_24h"),
);

async function copy(text: string, setCopied: (copied: boolean) => void): Promise<boolean> {
	const ok = await copyWithFeedback(text, setCopied, 1600);
	clipboardError = !ok;
	return ok;
}
</script>

<PageHero title={t("ok_title")} sub={password ? t("ok_sub_pw") : t("ok_sub")}>
	{#snippet badge()}
		<SuccessBadge />
	{/snippet}
</PageHero>

<section class="card rise" style:animation-delay="0.18s" aria-labelledby="share-label">
	<div class="flex flex-col gap-1.5 px-[18px] pt-4 pb-3.5">
		<span id="share-label" class="text-xs font-medium text-faint">{t("ok_link_label")}</span>
		<p class="url m-0" data-testid="share-url" title={shareUrl}>
			<span class="text-faint">{parts.scheme}</span><span class="text-text">{parts.address}</span><span
				class="text-accent-text">{parts.key}</span
			>
		</p>
	</div>

	{#if qrOpen}
		<div id="share-qr" class="pop flex flex-wrap items-center gap-x-5 gap-y-4 border-t border-line px-[18px] py-4">
			<QrCode url={shareUrl} label={t("qr_alt")} />
			<div class="flex min-w-[200px] flex-1 flex-col gap-1.5">
				<span class="text-sm font-medium">{t("ok_qr_title")}</span>
				<span class="text-[12.5px] text-faint">{t("ok_qr_warning")}</span>
			</div>
		</div>
	{/if}

	<div class="flex flex-wrap gap-2 border-t border-line p-3">
		<button
			type="button"
			class="btn btn-primary min-w-[200px] flex-1 text-[15px]"
			onclick={async () => {
				if (await copy(shareUrl, (v) => (linkCopied = v))) onlinkcopied();
			}}
		>
			{#if linkCopied}
				<span class="pop inline-flex items-center gap-2"><Icon name="check" size={16} stroke={2.4} />{t("ok_copied")}</span>
			{:else}
				<Icon name="copy" size={16} />{t("ok_copy")}
			{/if}
		</button>
		<button
			type="button"
			class="btn btn-outline"
			aria-expanded={qrOpen}
			aria-controls={qrOpen ? "share-qr" : undefined}
			onclick={() => (qrOpen = !qrOpen)}
		>
			<Icon name="qr" size={16} /><span class="max-[600px]:sr-only">{t("ok_qr")}</span>
		</button>
		<a href={mailto} class="btn btn-outline" aria-label={t("ok_email_label")}>
			<Icon name="mail" size={16} /><span class="max-[600px]:sr-only" aria-hidden="true">{t("ok_email")}</span>
		</a>
	</div>
</section>

{#if clipboardError}
	<p class="m-0 text-center text-[13px] text-danger" role="alert">{t("error_clipboard")}</p>
{/if}

<p class="rise -mt-1.5 mb-0 flex items-center justify-center gap-2 text-center text-[12.5px] text-muted" style:animation-delay="0.22s">
	<Icon name="alert" size={14} class="shrink-0 text-warn" />{t("ok_unload_warning")}
</p>

{#if password}
	<section
		class="panel rise flex flex-wrap items-center gap-x-3.5 gap-y-3 py-3.5 pr-3.5 pl-4"
		style:animation-delay="0.26s"
		aria-labelledby="password-title"
	>
		<span class="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-text">
			<Icon name="key" size={17} />
		</span>
		<div class="min-w-[220px] flex-1">
			<p id="password-title" class="m-0 text-sm font-medium">{t("ok_pw_title")}</p>
			<p class="m-0 text-[12.5px] text-faint">{t("ok_pw_hint")}</p>
		</div>
		<div class="flex items-center gap-1">
			<code class="px-1.5 font-mono text-sm tracking-wide">
				{passwordVisible ? password : "•".repeat(12)}
			</code>
			<button
				type="button"
				class="btn btn-ghost btn-sm btn-icon"
				aria-label={passwordVisible ? t("hide_password") : t("show_password")}
				onclick={() => (passwordVisible = !passwordVisible)}
			>
				<Icon name={passwordVisible ? "eye-off" : "eye"} size={16} />
			</button>
			<button
				type="button"
				class="btn btn-outline btn-sm"
				onclick={() => copy(password, (v) => (passwordCopied = v))}
			>
				{passwordCopied ? t("copied") : t("copy")}
			</button>
		</div>
	</section>
{/if}

<p class="rise mt-1 mb-0 text-center text-sm leading-[1.7] text-muted" style:animation-delay="0.3s">
	{#each rule as segment, index (index)}
		{#if "text" in segment}
			{segment.text}
		{:else}
			<strong class="font-medium text-text">{segment.slot === "reads" ? readsText : expiryText}</strong>
		{/if}
	{/each}
	{#if fileCount > 0}
		<span class="text-faint">
			· {tn("files_count", fileCount)}</span
		>
	{/if}
</p>

<div
	class="rise mt-2 flex flex-col items-center gap-3.5 border-t border-line pt-[22px]"
	style:animation-delay="0.34s"
>
	{#if manageUrl}
		<p class="m-0 text-center text-[13px] leading-[1.7] text-muted">
			{t("ok_manage_hint")}<br />
			<button
				type="button"
				class="manage"
				data-testid="manage-link"
				data-url={manageUrl}
				onclick={() => copy(manageUrl, (v) => (manageCopied = v))}
			>
				{manageCopied ? t("ok_manage_copied") : t("ok_manage_copy")}
			</button>
		</p>
	{/if}
	<button type="button" class="btn btn-outline h-10" onclick={onreset}>
		<Icon name="plus" size={15} />{t("ok_new")}
	</button>
</div>

<style>
	.url {
		font-family: var(--font-mono);
		font-size: 14.5px;
		line-height: 1.6;
		word-break: break-all;
	}

	.manage {
		padding: 0 2px;
		border: 0;
		border-bottom: 1.5px dashed color-mix(in srgb, var(--accent) 55%, transparent);
		background: transparent;
		color: var(--text);
		font: inherit;
		font-weight: 500;
	}

	.manage:hover {
		border-bottom-style: solid;
		border-bottom-color: var(--accent);
	}
</style>

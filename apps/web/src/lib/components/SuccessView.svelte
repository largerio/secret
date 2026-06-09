<script lang="ts">
import { EXPIRATION_OPTIONS } from "@largerio/secret-shared";
import Icon from "$lib/components/Icon.svelte";
import { getConfig } from "$lib/config.svelte";
import { t } from "$lib/i18n/index.svelte";
import { copyWithFeedback } from "$lib/utils/clipboard";

interface Props {
	shareUrl: string;
	qrCodeUrl: string;
	manageUrl: string;
	password: string;
	fileCount: number;
	expiresIn: number;
	maxReads: string;
	onreset: () => void;
}

const { shareUrl, qrCodeUrl, manageUrl, password, fileCount, expiresIn, maxReads, onreset }: Props =
	$props();

const config = $derived(getConfig());

let copied = $state(false);
let copiedPw = $state(false);
let manageCopied = $state(false);
let showQR = $state(false);
let clipboardError = $state("");

const isBurning = $derived(parseInt(maxReads, 10) === 1);

const expiryLabelKey = $derived.by(() => {
	const match = EXPIRATION_OPTIONS.find((o) => o.value === expiresIn);
	return match?.labelKey ?? "expiry_24h";
});

const shareUrlParts = $derived.by(() => {
	const hashIdx = shareUrl.indexOf("#");
	if (hashIdx < 0) return { protocol: "", host: shareUrl, fragment: "" };
	const beforeHash = shareUrl.slice(0, hashIdx);
	const fragment = shareUrl.slice(hashIdx);
	const protoIdx = beforeHash.indexOf("://");
	const protocol = protoIdx >= 0 ? beforeHash.slice(0, protoIdx + 3) : "";
	const host = protoIdx >= 0 ? beforeHash.slice(protoIdx + 3) : beforeHash;
	return { protocol, host, fragment };
});

const readsText = $derived(
	parseInt(maxReads, 10) === 1 ? t("reads_count_one") : t("reads_count_other", { count: maxReads }),
);

async function copy(text: string, setFlag: (v: boolean) => void) {
	clipboardError = "";
	const ok = await copyWithFeedback(text, setFlag);
	if (!ok) clipboardError = t("error_clipboard");
}
</script>

<section>
	<!-- Hero -->
	<div class="mb-9 flex flex-col items-start">
		<span
			class="mono mb-2 inline-flex items-center gap-1.5 uppercase"
			style:font-size="11px"
			style:letter-spacing="0.12em"
			style:color="var(--muted)"
		>
			<Icon name="check" size={11} />
			<span>{t("ok_eyebrow")}</span>
		</span>
		<h1
			class="serif"
			style:font-size="clamp(32px, 5vw, 40px)"
			style:margin="8px 0 24px"
			style:line-height="1.35"
			style:letter-spacing="-0.02em"
			style:font-weight="400"
			style:padding-bottom="8px"
		>
			{t("ok_hero_1")}
			<em style:color="var(--accent)">{t("ok_hero_unique")}</em>.<br />
			{t("ok_hero_2")}
			<span style:color="var(--muted)">{t("ok_hero_3")}</span>
		</h1>
		<p style:color="var(--muted)" style:font-size="15px" style:margin="0">
			{password ? t("ok_hero_sub_pw") : t("ok_hero_sub_nopw")}
		</p>
	</div>

	{#if clipboardError}
		<div
			class="mb-4 rounded-xl border px-4 py-3 text-sm"
			style:background="var(--accent-soft)"
			style:border-color="var(--accent-ring)"
			style:color="var(--text)"
			role="alert"
		>
			{clipboardError}
		</div>
	{/if}

	<!-- Link card -->
	<div
		class="relative mb-4 overflow-hidden rounded-2xl border"
		style:background="var(--bg-2)"
		style:border-color="var(--line)"
		style:padding="4px"
	>
		<div
			class="mono flex flex-wrap items-center gap-3 uppercase"
			style:padding="12px 16px 6px"
			style:font-size="10px"
			style:color="var(--muted-2)"
			style:letter-spacing="0.1em"
		>
			<span class="inline-flex items-center gap-1.5">
				<span
					class="inline-block"
					style:width="6px"
					style:height="6px"
					style:border-radius="2px"
					style:background="var(--muted)"
				></span>
				<span>{t("ok_legend_server")}</span>
			</span>
			<span class="inline-flex items-center gap-1.5">
				<span
					class="inline-block"
					style:width="6px"
					style:height="6px"
					style:border-radius="2px"
					style:background="var(--accent)"
				></span>
				<span>{t("ok_legend_key")}</span>
			</span>
		</div>
		<div class="flex flex-wrap items-center gap-3" style:padding="4px 18px 18px">
			<div
				class="min-w-0 flex-1 overflow-hidden"
				style:font-family="var(--font-mono)"
				style:font-size="14px"
				style:line-height="1.4"
				style:white-space="nowrap"
				style:text-overflow="ellipsis"
				title={shareUrl}
				data-testid="share-url"
			>
				<span style:color="var(--muted-2)">{shareUrlParts.protocol}</span><span
					style:color="var(--text)">{shareUrlParts.host}</span
				><span style:color="var(--accent)">{shareUrlParts.fragment}</span>
			</div>
			<button
				type="button"
				onclick={() => copy(shareUrl, (v) => (copied = v))}
				class="inline-flex items-center gap-1.5 rounded-lg border-0 transition-all"
				style:background="var(--accent)"
				style:color="var(--accent-ink)"
				style:padding="12px 18px"
				style:font-size="13px"
				style:font-weight="500"
				aria-label={t("ok_copy")}
			>
				<Icon name={copied ? "check" : "copy"} size={15} />
				<span>{copied ? t("copied") : t("ok_copy")}</span>
			</button>
		</div>
		<div class="flex" style:border-top="1px solid var(--line)" style:background="var(--bg-3)">
			<button
				type="button"
				onclick={() => (showQR = !showQR)}
				class="inline-flex flex-1 items-center justify-center gap-1.5 border-0 bg-transparent transition-colors"
				style:padding="12px"
				style:color={showQR ? "var(--text)" : "var(--muted)"}
				style:font-size="13px"
			>
				<Icon name="qr" size={14} />
				<span>{t("ok_qr")}</span>
			</button>
			<span style:width="1px" style:background="var(--line)"></span>
			<a
				href={`mailto:?subject=${encodeURIComponent(config.appName)}&body=${encodeURIComponent(shareUrl)}`}
				class="inline-flex flex-1 items-center justify-center gap-1.5 transition-colors"
				style:padding="12px"
				style:color="var(--muted)"
				style:font-size="13px"
			>
				<Icon name="mail" size={14} />
				<span>{t("ok_email")}</span>
			</a>
			<span style:width="1px" style:background="var(--line)"></span>
			<a
				href={shareUrl}
				target="_blank"
				rel="noopener noreferrer"
				class="inline-flex flex-1 items-center justify-center gap-1.5 transition-colors"
				style:padding="12px"
				style:color="var(--muted)"
				style:font-size="13px"
			>
				<Icon name="eye" size={14} />
				<span>{t("ok_preview")}</span>
			</a>
		</div>
	</div>

	{#if showQR && qrCodeUrl}
		<div
			class="mb-4 flex flex-col items-center gap-4 rounded-2xl border"
			style:background="var(--bg-2)"
			style:border-color="var(--line)"
			style:padding="24px"
		>
			<img
				src={qrCodeUrl}
				alt={t("qr_alt")}
				class="rounded-lg"
				style:background="var(--bg)"
				width="200"
				height="200"
			/>
			<p
				class="mono"
				style:font-size="11px"
				style:color="var(--muted)"
				style:margin="0"
				style:text-align="center"
			>
				{t("ok_qr_hint")}
			</p>
		</div>
	{/if}

	{#if password}
		<div
			class="mb-4 flex items-center gap-3 rounded-2xl border"
			style:background="var(--bg-2)"
			style:border-color="var(--line)"
			style:padding="16px"
		>
			<span
				class="grid place-items-center rounded-lg"
				style:width="36px"
				style:height="36px"
				style:background="var(--accent-soft)"
				style:color="var(--accent)"
			>
				<Icon name="key" size={16} />
			</span>
			<div class="min-w-0 flex-1">
				<div style:font-size="13px" style:font-weight="500">{t("ok_pw_title")}</div>
				<div class="mono" style:font-size="11px" style:color="var(--muted)">
					{t("ok_pw_hint")}
				</div>
			</div>
			<button
				type="button"
				onclick={() => copy(password, (v) => (copiedPw = v))}
				class="inline-flex items-center gap-1.5 rounded-lg border transition-colors"
				style:background="var(--bg-3)"
				style:border-color="var(--line)"
				style:color="var(--text)"
				style:padding="8px 14px"
				style:font-size="12px"
			>
				<Icon name={copiedPw ? "check" : "copy"} size={13} />
				<span>{copiedPw ? t("copied") : t("copy_button")}</span>
			</button>
		</div>
	{/if}

	<!-- Facts -->
	<div
		class="mb-8 rounded-2xl border"
		style:background="color-mix(in srgb, var(--accent) 5%, var(--bg-2))"
		style:border-color="var(--line)"
		style:padding="20px 24px"
	>
		<div
			class="mono mb-3 inline-flex items-center gap-1.5 uppercase"
			style:font-size="11px"
			style:letter-spacing="0.12em"
			style:color="var(--muted)"
		>
			<Icon name="warn" size={11} />
			<span>{t("ok_facts_title")}</span>
		</div>
		<ul class="m-0 flex list-none flex-col gap-2.5 p-0">
			<li class="flex items-center gap-3">
				<span
					class="grid shrink-0 place-items-center rounded-md"
					style:width="26px"
					style:height="26px"
					style:background="var(--bg-3)"
					style:color="var(--muted)"
				>
					<Icon name="clock" size={13} />
				</span>
				<span style:color="var(--muted)" style:font-size="13px" style:min-width="140px"
					>{t("ok_facts_expiry")}</span
				>
				<span class="mono" style:color="var(--text)" style:font-size="12px" style:font-weight="500"
					>{t(expiryLabelKey)}</span
				>
			</li>
			<li class="flex items-center gap-3">
				<span
					class="grid shrink-0 place-items-center rounded-md"
					style:width="26px"
					style:height="26px"
					style:background="var(--bg-3)"
					style:color={isBurning ? "var(--accent)" : "var(--muted)"}
				>
					<Icon name={isBurning ? "flame" : "eye"} size={13} />
				</span>
				<span style:color="var(--muted)" style:font-size="13px" style:min-width="140px"
					>{t("ok_facts_reads")}</span
				>
				<span
					class="mono"
					style:color={isBurning ? "var(--accent)" : "var(--text)"}
					style:font-size="12px"
					style:font-weight="500">{readsText}</span
				>
			</li>
			{#if fileCount > 0}
				<li class="flex items-center gap-3">
					<span
						class="grid shrink-0 place-items-center rounded-md"
						style:width="26px"
						style:height="26px"
						style:background="var(--bg-3)"
						style:color="var(--muted)"
					>
						<Icon name="paperclip" size={13} />
					</span>
					<span style:color="var(--muted)" style:font-size="13px" style:min-width="140px"
						>{t("ok_facts_files")}</span
					>
					<span
						class="mono"
						style:color="var(--text)"
						style:font-size="12px"
						style:font-weight="500">{t("files_count", { count: fileCount })}</span
					>
				</li>
			{/if}
		</ul>
	</div>

	{#if manageUrl}
		<details class="mb-6">
			<summary
				class="mono cursor-pointer uppercase"
				style:font-size="11px"
				style:letter-spacing="0.1em"
				style:color="var(--muted-2)"
			>
				{t("delete_label")}
			</summary>
			<div class="mt-3 flex flex-col gap-2">
				<div class="flex gap-2">
					<input
						id="manage-url"
						type="text"
						readonly
						value={manageUrl}
						class="min-w-0 flex-1 rounded-lg border outline-none"
						style:background="var(--bg-2)"
						style:border-color="var(--line)"
						style:color="var(--muted)"
						style:padding="10px 12px"
						style:font-family="var(--font-mono)"
						style:font-size="11px"
					/>
					<button
						type="button"
						onclick={() => copy(manageUrl, (v) => (manageCopied = v))}
						class="inline-flex items-center gap-1.5 rounded-lg border transition-colors"
						style:background="var(--bg-2)"
						style:border-color="var(--line)"
						style:color="var(--muted)"
						style:padding="10px 14px"
						style:font-size="12px"
					>
						<Icon name={manageCopied ? "check" : "copy"} size={13} />
						<span>{manageCopied ? t("delete_copied") : t("copy_button")}</span>
					</button>
				</div>
				<p style:font-size="11px" style:color="var(--muted-2)">
					{t("delete_warning")}
				</p>
			</div>
		</details>
	{/if}

	<button
		type="button"
		onclick={onreset}
		class="inline-flex w-full items-center justify-center gap-2 rounded-xl border transition-colors"
		style:background="var(--bg-2)"
		style:border-color="var(--line)"
		style:color="var(--text)"
		style:padding="14px"
		style:font-size="14px"
	>
		<Icon name="lock" size={14} />
		<span>{t("ok_new")}</span>
	</button>
</section>

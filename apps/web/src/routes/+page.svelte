<script lang="ts">
import type { ContentMode } from "@largerio/secret-shared";
import { MAX_TEXT_SIZE } from "@largerio/secret-shared";
import type { ProgressInfo, UploadPhase } from "@largerio/secret-sdk";
import EncryptionBadge from "$lib/components/EncryptionBadge.svelte";
import FileDropZone from "$lib/components/FileDropZone.svelte";
import Icon from "$lib/components/Icon.svelte";
import MarkdownEditor from "$lib/components/MarkdownEditor.svelte";
import PasswordGenerator from "$lib/components/PasswordGenerator.svelte";
import SecuritySettings from "$lib/components/SecuritySettings.svelte";
import StepProgress from "$lib/components/StepProgress.svelte";
import SuccessView from "$lib/components/SuccessView.svelte";
import { getClient } from "$lib/client";
import { getConfig } from "$lib/config.svelte";
import { t } from "$lib/i18n/index.svelte";
import { setStep } from "$lib/steps.svelte";
import { solveCap } from "$lib/utils/cap";

let mounted = $state(false);
$effect(() => {
	mounted = true;
});

$effect(() => {
	setStep(shareUrl ? 2 : 1);
});

// Form state
let contentMode = $state<ContentMode>("text");
let text = $state("");
let files = $state<File[]>([]);
let password = $state("");
let expiresIn = $state(86400);
let maxReads = $state("1");

// Submission state
let isSubmitting = $state(false);
let error = $state("");
let uploadProgress = $state<number | null>(null);
let uploadPhase = $state<UploadPhase>("encrypting");
let uploadChunkLabel = $state("");

// Result state
let shareUrl = $state("");
let qrCodeUrl = $state("");
let manageUrl = $state("");
let createdFileCount = $state(0);

const config = $derived(getConfig());
const maxFileSize = $derived(config.maxChunkedFileSize || config.maxFileSize);
const maxFilesPerNote = $derived(config.maxFilesPerNote);

const canSubmit = $derived(!!(text.trim() || files.length > 0));

async function handleSubmit() {
	if (!text && files.length === 0) {
		error = t("error_empty_content");
		return;
	}
	if (text.length > MAX_TEXT_SIZE) {
		error = t("error_text_too_long", { max: String(MAX_TEXT_SIZE / 1024) });
		return;
	}

	error = "";
	isSubmitting = true;
	uploadProgress = null;

	try {
		const capToken = await solveCap();
		const client = await getClient();
		const parsed = parseInt(maxReads, 10);
		const parsedMaxReads = Number.isNaN(parsed) ? 1 : parsed;

		const noteFiles = await Promise.all(
			files.map(async (file) => {
				const buffer = await file.arrayBuffer();
				return { name: file.name, type: file.type, data: new Uint8Array(buffer) };
			}),
		);

		const result = await client.createNote({
			...(text ? { text, contentMode } : {}),
			...(noteFiles.length > 0 ? { files: noteFiles } : {}),
			...(password ? { password } : {}),
			expiresIn,
			maxReads: parsedMaxReads,
			capToken,
			onUploadProgress: (p) => {
				uploadProgress = p * 100;
			},
			onProgress: (info: ProgressInfo) => {
				uploadPhase = info.phase as UploadPhase;
				uploadProgress = info.overallProgress * 100;
				if (info.currentChunk && info.totalChunks && info.totalChunks > 1) {
					uploadChunkLabel = t("chunk_progress", {
						current: String(info.currentChunk),
						total: String(info.totalChunks),
					});
				} else {
					uploadChunkLabel = "";
				}
			},
		});

		const url = `${window.location.origin}/note/${result.id}#${result.keyFragment}`;
		createdFileCount = files.length;
		shareUrl = url;
		manageUrl = `${window.location.origin}/note/${result.id}/manage#${result.deleteToken}`;
		const { toDataURL } = await import("qrcode");
		qrCodeUrl = await toDataURL(url, { width: 256, margin: 2 });
	} catch (e) {
		error = e instanceof Error ? e.message : t("error_generic");
	} finally {
		isSubmitting = false;
		uploadProgress = null;
	}
}

function reset() {
	contentMode = "text";
	text = "";
	files = [];
	password = "";
	expiresIn = 86400;
	maxReads = "1";
	shareUrl = "";
	manageUrl = "";
	qrCodeUrl = "";
	createdFileCount = 0;
	error = "";
	uploadPhase = "encrypting";
	uploadChunkLabel = "";
}

const TABS: {
	id: ContentMode;
	labelKey: "content_mode_text" | "content_mode_markdown" | "content_mode_secret";
	subKey: "tab_text_sub" | "tab_markdown_sub" | "tab_secret_sub";
	icon: "text" | "md" | "key";
}[] = [
	{ id: "text", labelKey: "content_mode_text", subKey: "tab_text_sub", icon: "text" },
	{ id: "markdown", labelKey: "content_mode_markdown", subKey: "tab_markdown_sub", icon: "md" },
	{ id: "secret", labelKey: "content_mode_secret", subKey: "tab_secret_sub", icon: "key" },
];
</script>

<svelte:head>
	<title>{t("seo_title")}</title>
	<meta name="description" content={t("seo_description")} />
	<meta name="keywords" content={t("seo_keywords")} />
	<link rel="canonical" href={config.appUrl || "https://secret.larger.io"} />
	<meta property="og:title" content={t("seo_title")} />
	<meta property="og:description" content={t("seo_description")} />
	<meta property="og:url" content={config.appUrl || "https://secret.larger.io"} />
	<meta name="twitter:title" content={t("seo_title")} />
	<meta name="twitter:description" content={t("seo_description")} />
	{@html `<script type="application/ld+json">${JSON.stringify({
		"@context": "https://schema.org",
		"@type": "WebApplication",
		name: config.appName,
		url: config.appUrl || "https://secret.larger.io",
		description: t("seo_description"),
		applicationCategory: "SecurityApplication",
		operatingSystem: "Any",
		offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
		featureList: [
			"End-to-end encryption",
			"Zero-knowledge architecture",
			"Burn after reading",
			"Password protection",
			"File sharing",
			"QR code sharing",
			"Self-hostable",
		],
	}).replace(/</g, "\\u003c")}</script>`}
</svelte:head>

{#if shareUrl}
	<SuccessView
		{shareUrl}
		{qrCodeUrl}
		{manageUrl}
		{password}
		fileCount={createdFileCount}
		{expiresIn}
		{maxReads}
		onreset={reset}
	/>
{:else}
	<form
		onsubmit={(e) => {
			e.preventDefault();
			handleSubmit();
		}}
	>
		<div class="mb-10">
			<EncryptionBadge />
			<h1
				class="serif"
				style:font-size="clamp(36px, 6vw, 48px)"
				style:margin="20px 0 20px"
				style:line-height="1.25"
				style:letter-spacing="-0.02em"
				style:font-weight="400"
				style:padding-bottom="4px"
			>
				{t("create_hero_1")}<br />
				<em style:color="var(--accent)">{t("create_hero_2")}</em>
			</h1>
			<p style:color="var(--muted)" style:font-size="16px" style:max-width="560px" style:margin="0">
				{t("create_hero_sub")}
			</p>
		</div>

		{#if error}
			<div
				class="mb-6 rounded-xl border px-4 py-3 text-sm"
				style:background="var(--accent-soft)"
				style:border-color="var(--accent-ring)"
				style:color="var(--text)"
				role="alert"
			>
				{error}
			</div>
		{/if}

		<!-- Segmented tabs -->
		<div
			role="tablist"
			class="mb-6 grid gap-1.5 rounded-2xl border"
			style:grid-template-columns="repeat(3, 1fr)"
			style:background="var(--bg-2)"
			style:border-color="var(--line)"
			style:padding="6px"
		>
			{#each TABS as tab (tab.id)}
				{@const active = contentMode === tab.id}
				<button
					type="button"
					role="tab"
					aria-selected={active}
					onclick={() => (contentMode = tab.id)}
					class="flex flex-col items-start gap-1 rounded-xl border-0 transition-all"
					style:background={active ? "var(--bg-3)" : "transparent"}
					style:color={active ? "var(--text)" : "var(--muted)"}
					style:padding="12px 14px"
				>
					<span class="flex items-center gap-2" style:font-size="14px" style:font-weight="500">
						<span style:color={active ? "var(--accent)" : "var(--muted)"}>
							<Icon name={tab.icon} size={16} />
						</span>
						<span>{t(tab.labelKey)}</span>
					</span>
					<span class="mono hidden sm:inline" style:font-size="10px" style:color="var(--muted-2)"
						>{t(tab.subKey)}</span
					>
				</button>
			{/each}
		</div>

		<!-- Editor -->
		<div class="mb-6">
			{#if contentMode === "secret"}
				<PasswordGenerator bind:value={text} />
			{:else if contentMode === "markdown"}
				<div class="relative">
					<MarkdownEditor
						bind:value={text}
						maxlength={MAX_TEXT_SIZE}
						placeholder={t("text_placeholder_md")}
					/>
					<div
						class="mono pointer-events-none absolute"
						style:bottom="12px"
						style:right="14px"
						style:font-size="10px"
						style:color="var(--muted-2)"
					>
						{text.length.toLocaleString()} / {MAX_TEXT_SIZE.toLocaleString()}
					</div>
				</div>
			{:else}
				<div class="relative">
					<textarea
						id="note-text"
						bind:value={text}
						placeholder={t("text_placeholder")}
						rows="8"
						maxlength={MAX_TEXT_SIZE}
						class="w-full rounded-xl border outline-none transition-colors"
						style:background="var(--bg-2)"
						style:border-color="var(--line)"
						style:color="var(--text)"
						style:padding="14px 16px"
						style:font-size="15px"
						style:line-height="1.6"
						style:resize="vertical"
						style:min-height="180px"
					></textarea>
					<div
						class="mono pointer-events-none absolute"
						style:bottom="12px"
						style:right="14px"
						style:font-size="10px"
						style:color="var(--muted-2)"
					>
						{text.length.toLocaleString()} / {MAX_TEXT_SIZE.toLocaleString()}
					</div>
				</div>
			{/if}
		</div>

		<!-- Files dropzone -->
		{#if contentMode !== "secret"}
			<FileDropZone bind:files {maxFileSize} {maxFilesPerNote} />
		{/if}

		<!-- Security settings -->
		<SecuritySettings bind:password bind:expiresIn bind:maxReads />

		{#if isSubmitting}
			<div class="mb-4">
				<StepProgress
					steps={[
						{ key: "encrypting", label: t("step_encrypting"), icon: "fa-solid fa-shield-halved" },
						{ key: "uploading", label: t("step_uploading"), icon: "fa-solid fa-cloud-arrow-up" },
						{ key: "done", label: t("step_done"), icon: "fa-solid fa-check" },
					]}
					currentStep={uploadPhase === "encrypting" ? 0 : uploadPhase === "uploading" ? 1 : 2}
					progress={uploadProgress ?? 0}
					label={uploadChunkLabel}
				/>
			</div>
		{/if}

		<button
			type="submit"
			disabled={!mounted || isSubmitting || !canSubmit}
			class="inline-flex w-full items-center justify-center gap-2 rounded-xl border-0 transition-all disabled:cursor-not-allowed disabled:opacity-50"
			style:background="var(--accent)"
			style:color="var(--accent-ink)"
			style:padding="16px 24px"
			style:font-size="15px"
			style:font-weight="500"
		>
			{#if isSubmitting}
				<span class="spinner"></span>
				<span>{t("submit_encrypting")}</span>
			{:else}
				<Icon name="lock" size={16} />
				<span>{t("submit_encrypt")}</span>
				<Icon name="arrow-right" size={15} class="opacity-80" />
			{/if}
		</button>

		<p
			class="mono mt-6 text-center"
			style:font-size="11px"
			style:color="var(--muted-2)"
			style:line-height="1.7"
		>
			{t("disclaimer_1")} <code style:color="var(--muted)">#</code><br />
			{t("disclaimer_2")}
		</p>
	</form>
{/if}

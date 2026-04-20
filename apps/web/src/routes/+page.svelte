<script lang="ts">
import type { ContentMode } from "@secret/shared";
import { EXPIRATION_OPTIONS, MAX_TEXT_SIZE } from "@secret/shared";
import type { ProgressInfo, UploadPhase } from "@secret/sdk-js";
import EncryptionBadge from "$lib/components/EncryptionBadge.svelte";
import Icon from "$lib/components/Icon.svelte";
import MarkdownEditor from "$lib/components/MarkdownEditor.svelte";
import PasswordGenerator from "$lib/components/PasswordGenerator.svelte";
import StepProgress from "$lib/components/StepProgress.svelte";
import { getClient } from "$lib/client";
import { getConfig } from "$lib/config.svelte";
import { t } from "$lib/i18n/index.svelte";
import { setStep } from "$lib/steps.svelte";
import { solveCap } from "$lib/utils/cap";
import { formatSize } from "$lib/utils/format";

let mounted = $state(false);
$effect(() => {
	mounted = true;
});

$effect(() => {
	setStep(shareUrl ? 2 : 1);
});

let contentMode = $state<ContentMode>("text");
let text = $state("");
let files = $state<File[]>([]);
let password = $state("");
let showPassword = $state(false);
let expiresIn = $state(86400);
let maxReads = $state("1");
let isSubmitting = $state(false);
let error = $state("");
let shareUrl = $state("");
let qrCodeUrl = $state("");
let manageUrl = $state("");
let copied = $state(false);
let manageCopied = $state(false);
let isDragging = $state(false);
let uploadProgress = $state<number | null>(null);
let uploadPhase = $state<UploadPhase>("encrypting");
let uploadChunkLabel = $state("");
let fileInputEl: HTMLInputElement | undefined = $state();

const config = $derived(getConfig());
const maxFileSize = $derived(config.maxChunkedFileSize || config.maxFileSize);
const maxTotalSize = $derived(config.maxChunkedFileSize || config.maxFileSize);
const maxFilesPerNote = $derived(config.maxFilesPerNote);
let fileError = $state("");

const pwStrength = $derived.by(() => {
	if (!password) return { score: 0, label: "", color: "var(--muted-2)" };
	let s = 0;
	if (password.length >= 8) s++;
	if (password.length >= 14) s++;
	if (/[A-Z]/.test(password) && /[a-z]/.test(password)) s++;
	if (/\d/.test(password)) s++;
	if (/[^\w\s]/.test(password)) s++;
	const keys = ["str_vweak", "str_weak", "str_ok", "str_strong", "str_exc"] as const;
	const colors = ["#ef4444", "#f97316", "#eab308", "#84cc16", "#10b981"];
	const idx = Math.min(s - 1, 4);
	return {
		score: s,
		label: idx >= 0 ? t(keys[idx]) : "",
		color: idx >= 0 ? (colors[idx] ?? "#ef4444") : "#ef4444",
	};
});

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
		const parsed = parseInt(String(maxReads), 10);
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

function handleDrop(event: DragEvent) {
	event.preventDefault();
	isDragging = false;
	const droppedFiles = event.dataTransfer?.files;
	if (droppedFiles) {
		addFiles(Array.from(droppedFiles));
	}
}

function handleFileInput(event: Event) {
	const input = event.target as HTMLInputElement;
	if (input.files) {
		addFiles(Array.from(input.files));
	}
}

function addFiles(newFiles: File[]) {
	fileError = "";
	const oversized = newFiles.filter((f) => f.size > maxFileSize);
	if (oversized.length > 0) {
		fileError = t("error_file_too_large", { size: formatSize(maxFileSize) });
		return;
	}

	const remaining = maxFilesPerNote - files.length;
	const candidates = [...files, ...newFiles.slice(0, remaining)];
	const totalSize = candidates.reduce((sum, f) => sum + f.size, 0);
	if (totalSize > maxTotalSize) {
		fileError = t("error_total_too_large", { size: formatSize(maxTotalSize) });
		return;
	}

	files = candidates;
}

function removeFile(index: number) {
	files = files.filter((_, i) => i !== index);
}

async function copyToClipboard() {
	try {
		await navigator.clipboard.writeText(shareUrl);
		copied = true;
		setTimeout(() => {
			copied = false;
		}, 2000);
	} catch {
		error = t("error_clipboard");
	}
}

async function copyManageUrl() {
	try {
		await navigator.clipboard.writeText(manageUrl);
		manageCopied = true;
		setTimeout(() => {
			manageCopied = false;
		}, 2000);
	} catch {
		error = t("error_clipboard");
	}
}

function generatePwField() {
	const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%";
	const arr = new Uint32Array(20);
	crypto.getRandomValues(arr);
	let pw = "";
	for (let i = 0; i < 20; i++) pw += chars[(arr[i] ?? 0) % chars.length];
	password = pw;
	showPassword = true;
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
	error = "";
	uploadPhase = "encrypting";
	uploadChunkLabel = "";
}

const TABS: { id: ContentMode; labelKey: "content_mode_text" | "content_mode_markdown" | "content_mode_secret"; subKey: "tab_text_sub" | "tab_markdown_sub" | "tab_secret_sub"; icon: "text" | "md" | "key" }[] = [
	{ id: "text", labelKey: "content_mode_text", subKey: "tab_text_sub", icon: "text" },
	{ id: "markdown", labelKey: "content_mode_markdown", subKey: "tab_markdown_sub", icon: "md" },
	{ id: "secret", labelKey: "content_mode_secret", subKey: "tab_secret_sub", icon: "key" },
];

const READS = [
	{ value: "1", key: "reads_1" as const },
	{ value: "3", key: "reads_3" as const },
	{ value: "10", key: "reads_10" as const },
	{ value: "100", key: "reads_100" as const },
];

const canSubmit = $derived(!!(text.trim() || files.length > 0));
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
	<!-- TODO(redesign): editorial success screen — step 3 -->
	<div class="space-y-6">
		<div
			class="rounded-2xl border"
			style:background="var(--bg-2)"
			style:border-color="var(--line)"
			style:padding="24px"
		>
			<h2
				class="serif mb-4"
				style:font-size="28px"
				style:color="var(--text)">{t("success_title")}</h2
			>

			<div class="space-y-4">
				<div>
					<label
						for="share-url"
						class="mono mb-1 block uppercase"
						style:font-size="11px"
						style:letter-spacing="0.08em"
						style:color="var(--muted)">{t("share_label")}</label
					>
					<div class="flex gap-2">
						<input
							id="share-url"
							type="text"
							readonly
							value={shareUrl}
							class="flex-1 rounded-lg border px-3 py-2 text-sm"
							style:background="var(--bg-2)"
							style:border-color="var(--line)"
							style:color="var(--text)"
						/>
						<button
							onclick={copyToClipboard}
							class="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium transition-colors"
							style:background="var(--accent)"
							style:color="var(--accent-ink)"
							aria-label={t("copy_button")}
						>
							<Icon name={copied ? "check" : "copy"} size={14} />
							{copied ? t("copied") : t("copy_button")}
						</button>
					</div>
				</div>

				{#if qrCodeUrl}
					<div class="flex justify-center">
						<img
							src={qrCodeUrl}
							alt={t("qr_alt")}
							class="rounded-lg"
							width="256"
							height="256"
						/>
					</div>
				{/if}

				{#if manageUrl}
					<details class="group">
						<summary
							class="mono cursor-pointer uppercase transition-colors"
							style:font-size="11px"
							style:letter-spacing="0.08em"
							style:color="var(--muted-2)">{t("delete_label")}</summary
						>
						<div class="mt-2 space-y-2">
							<div class="flex gap-2">
								<input
									id="manage-url"
									type="text"
									readonly
									value={manageUrl}
									class="flex-1 rounded-lg border px-3 py-2 text-xs"
									style:background="var(--bg-2)"
									style:border-color="var(--line)"
									style:color="var(--muted)"
								/>
								<button
									onclick={copyManageUrl}
									class="rounded-lg border px-3 py-2 text-xs transition-colors"
									style:background="var(--bg-2)"
									style:border-color="var(--line)"
									style:color="var(--muted)"
									aria-label={t("copy_button")}
								>
									{manageCopied ? t("delete_copied") : t("copy_button")}
								</button>
							</div>
							<p style:font-size="11px" style:color="var(--muted-2)">
								{t("delete_warning")}
							</p>
						</div>
					</details>
				{/if}
			</div>
		</div>

		<button
			onclick={reset}
			class="w-full rounded-lg border px-4 py-3 text-sm font-medium transition-colors"
			style:background="var(--bg-2)"
			style:border-color="var(--line)"
			style:color="var(--text)"
		>
			+ {t("create_another")}
		</button>
	</div>
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
			<div class="mb-8">
				<label
					class="mono mb-2 flex items-center gap-1.5 uppercase"
					style:font-size="11px"
					style:letter-spacing="0.08em"
					style:color="var(--muted)"
				>
					<Icon name="paperclip" size={12} />
					<span>{t("files_label")}</span>
				</label>
				<button
					type="button"
					onclick={() => fileInputEl?.click()}
					ondragover={(e) => {
						e.preventDefault();
						isDragging = true;
					}}
					ondragleave={() => {
						isDragging = false;
					}}
					ondrop={handleDrop}
					class="w-full rounded-xl text-left transition-all"
					style:background={isDragging ? "var(--accent-soft)" : "var(--bg-2)"}
					style:border={`1px dashed ${isDragging ? "var(--accent)" : "var(--line-2)"}`}
					style:padding="20px"
					aria-label={t("files_drop")}
				>
					<input
						id="file-upload"
						bind:this={fileInputEl}
						type="file"
						multiple
						onchange={handleFileInput}
						class="hidden"
					/>
					{#if files.length === 0}
						<div class="flex items-center justify-between gap-4">
							<div>
								<div style:color="var(--text)" style:font-size="14px">
									{t("files_drop_1")}
									<span style:color="var(--accent)">{t("files_drop_2")}</span>
								</div>
								<div
									class="mono"
									style:color="var(--muted-2)"
									style:font-size="11px"
									style:margin-top="4px"
								>
									{t("files_limit", {
										count: maxFilesPerNote,
										size: formatSize(maxTotalSize),
									})}
								</div>
							</div>
							<Icon name="paperclip" size={20} class="opacity-60" />
						</div>
					{:else}
						<div class="flex flex-col gap-2">
							{#each files as f, i (f.name + i)}
								<div
									class="flex items-center gap-2.5 rounded-lg"
									style:background="var(--bg-3)"
									style:padding="8px 10px"
								>
									<Icon name="file" size={14} class="shrink-0" />
									<span
										class="flex-1 truncate"
										style:font-size="13px"
										style:color="var(--text)"
									>
										{f.name}
									</span>
									<span class="mono" style:font-size="11px" style:color="var(--muted-2)">
										{formatSize(f.size)}
									</span>
									<button
										type="button"
										onclick={(e) => {
											e.stopPropagation();
											removeFile(i);
										}}
										class="border-0 bg-transparent p-1"
										style:color="var(--muted)"
										aria-label={t("remove_file", { name: f.name })}
									>
										<Icon name="x" size={14} />
									</button>
								</div>
							{/each}
							<div
								class="mono"
								style:font-size="11px"
								style:color="var(--muted-2)"
								style:padding-left="4px"
								style:margin-top="4px"
							>
								{t("files_add_more")} ({files.length}/{maxFilesPerNote})
							</div>
						</div>
					{/if}
				</button>
				{#if fileError}
					<p class="mt-2" style:font-size="12px" style:color="var(--accent)">{fileError}</p>
				{/if}
			</div>
		{/if}

		<!-- Security settings -->
		<div
			class="mb-6 rounded-2xl border"
			style:background="var(--bg-2)"
			style:border-color="var(--line)"
			style:padding="24px"
		>
			<div
				class="mono mb-4 inline-flex items-center gap-1.5 uppercase"
				style:font-size="11px"
				style:letter-spacing="0.12em"
				style:color="var(--muted)"
			>
				<Icon name="shield" size={11} />
				<span>{t("security_settings")}</span>
			</div>

			<div class="flex flex-col gap-5">
				<div class="flex flex-col gap-2">
					<label
						for="password"
						class="mono flex items-center gap-1.5 uppercase"
						style:font-size="11px"
						style:letter-spacing="0.08em"
						style:color="var(--muted)"
					>
						<Icon name="lock" size={12} />
						<span>{t("password_add_label")}</span>
					</label>
					<div class="relative">
						<input
							id="password"
							type={showPassword ? "text" : "password"}
							bind:value={password}
							placeholder={t("password_add_placeholder")}
							autocomplete="off"
							class="w-full rounded-xl border outline-none transition-colors"
							style:background="var(--bg-2)"
							style:border-color="var(--line)"
							style:color="var(--text)"
							style:padding="12px 88px 12px 14px"
							style:font-size="14px"
						/>
						<div
							class="absolute flex gap-0.5"
							style:right="8px"
							style:top="50%"
							style:transform="translateY(-50%)"
						>
							<button
								type="button"
								onclick={generatePwField}
								class="inline-flex items-center justify-center rounded-md border-0 bg-transparent"
								style:color="var(--muted)"
								style:padding="6px 8px"
								title="Generate"
							>
								<Icon name="dice" size={14} />
							</button>
							<button
								type="button"
								onclick={() => (showPassword = !showPassword)}
								class="inline-flex items-center justify-center rounded-md border-0 bg-transparent"
								style:color="var(--muted)"
								style:padding="6px 8px"
								title={showPassword ? t("theme_light") : t("theme_dark")}
							>
								<Icon name={showPassword ? "eye-off" : "eye"} size={14} />
							</button>
						</div>
					</div>
					{#if password}
						<div class="flex items-center gap-2.5" style:margin-top="4px">
							<div
								class="flex-1 overflow-hidden rounded-full"
								style:height="4px"
								style:background="var(--bg-3)"
							>
								<div
									class="h-full transition-all"
									style:width="{(pwStrength.score / 5) * 100}%"
									style:background={pwStrength.color}
								></div>
							</div>
							<span
								class="mono"
								style:font-size="10px"
								style:color={pwStrength.color}
								style:min-width="70px"
								style:text-align="right">{pwStrength.label}</span
							>
						</div>
					{/if}
					<span class="mono" style:font-size="11px" style:color="var(--muted-2)">
						{t("password_add_hint")}
					</span>
				</div>

				<div class="grid grid-cols-1 gap-5 sm:grid-cols-2">
					<div class="flex flex-col gap-2">
						<label
							for="expires"
							class="mono flex items-center gap-1.5 uppercase"
							style:font-size="11px"
							style:letter-spacing="0.08em"
							style:color="var(--muted)"
						>
							<Icon name="clock" size={12} />
							<span>{t("expires_label")}</span>
						</label>
						<select
							id="expires"
							bind:value={expiresIn}
							class="w-full rounded-xl border outline-none transition-colors"
							style:background="var(--bg-2)"
							style:border-color="var(--line)"
							style:color="var(--text)"
							style:padding="12px 14px"
							style:font-size="14px"
						>
							{#each EXPIRATION_OPTIONS as option (option.value)}
								<option value={option.value}>{t(option.labelKey)}</option>
							{/each}
						</select>
					</div>

					<div class="flex flex-col gap-2">
						<label
							for="max-reads"
							class="mono flex items-center gap-1.5 uppercase"
							style:font-size="11px"
							style:letter-spacing="0.08em"
							style:color="var(--muted)"
						>
							<Icon name="eye" size={12} />
							<span>{t("max_reads_label")}</span>
						</label>
						<select
							id="max-reads"
							bind:value={maxReads}
							class="w-full rounded-xl border outline-none transition-colors"
							style:background="var(--bg-2)"
							style:border-color="var(--line)"
							style:color="var(--text)"
							style:padding="12px 14px"
							style:font-size="14px"
						>
							{#each READS as r (r.value)}
								<option value={r.value}>{t(r.key)}</option>
							{/each}
						</select>
					</div>
				</div>
			</div>
		</div>

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

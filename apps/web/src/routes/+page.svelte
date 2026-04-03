<script lang="ts">
import type { ContentMode } from "@secret/shared";
import { EXPIRATION_OPTIONS, MAX_TEXT_SIZE } from "@secret/shared";
import type { ProgressInfo, UploadPhase } from "@secret/sdk-js";
import MarkdownEditor from "$lib/components/MarkdownEditor.svelte";
import PasswordGenerator from "$lib/components/PasswordGenerator.svelte";
import StepProgress from "$lib/components/StepProgress.svelte";
import { onMount } from "svelte";
import { getClient } from "$lib/client";
import { getConfig } from "$lib/config.svelte";
import { t } from "$lib/i18n/index.svelte";
import { solveCap } from "$lib/utils/cap";
import { formatSize } from "$lib/utils/format";

let mounted = $state(false);
onMount(() => {
	mounted = true;
});

let contentMode = $state<ContentMode>("text");
let text = $state("");
let files = $state<File[]>([]);
let password = $state("");
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

const config = $derived(getConfig());
const maxFileSize = $derived(config.maxFileSize);
const maxFilesPerNote = $derived(config.maxFilesPerNote);

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
	const validFiles = newFiles.filter((f) => f.size <= maxFileSize);
	const remaining = maxFilesPerNote - files.length;
	files = [...files, ...validFiles.slice(0, remaining)];
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
	<div class="space-y-6">
		<div class="rounded-xl border border-green-800/50 bg-green-900/20 p-6">
			<h2 class="mb-4 text-lg font-semibold text-green-300">{t("success_title")}</h2>

			<div class="space-y-4">
				<div>
					<label for="share-url" class="mb-1 block text-sm text-slate-400"
						>{t("share_label")}</label
					>
					<div class="flex gap-2">
						<input
							id="share-url"
							type="text"
							readonly
							value={shareUrl}
							class="flex-1 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white"
						/>
						<button
							onclick={copyToClipboard}
							class="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark transition-colors"
							aria-label={t("copy_button")}
						>
							<i class="fa-regular fa-copy"></i> {copied ? t("copied") : t("copy_button")}
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
						<summary class="cursor-pointer text-xs text-slate-500 hover:text-slate-400 transition-colors">
							<i class="fa-solid fa-gear"></i> {t("delete_label")}
						</summary>
						<div class="mt-2 space-y-2">
							<div class="flex gap-2">
								<input
									id="manage-url"
									type="text"
									readonly
									value={manageUrl}
									class="flex-1 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-400"
								/>
								<button
									onclick={copyManageUrl}
									class="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-400 hover:text-slate-300 hover:bg-slate-700 transition-colors"
									aria-label={t("copy_button")}
								>
									<i class="fa-regular fa-copy"></i> {manageCopied ? t("delete_copied") : t("copy_button")}
								</button>
							</div>
							<p class="text-xs text-slate-600">
								{t("delete_warning")}
							</p>
						</div>
					</details>
				{/if}
			</div>
		</div>

		<button
			onclick={reset}
			class="w-full rounded-lg border border-slate-700 bg-slate-800 px-4 py-3 text-sm font-medium text-white hover:bg-slate-700 transition-colors"
		>
			<i class="fa-solid fa-plus"></i> {t("create_another")}
		</button>
	</div>
{:else}
	<form
		onsubmit={(e) => {
			e.preventDefault();
			handleSubmit();
		}}
		class="space-y-6"
	>
		<h1 class="text-2xl font-bold">{t("create_title")}</h1>
		<p class="text-slate-400">{t("create_description")}</p>

		{#if error}
			<div
				class="rounded-lg border border-red-800/50 bg-red-900/20 px-4 py-3 text-sm text-red-300"
				role="alert"
			>
				{error}
			</div>
		{/if}

		<ul class="flex w-full rounded-lg border border-slate-700 bg-slate-800 text-xs font-medium sm:text-sm">
			<li class="flex-1 border-r border-slate-700">
				<label class="flex w-full cursor-pointer items-center justify-center gap-1.5 px-2 py-2.5 sm:gap-2 sm:px-3 {contentMode === 'text' ? 'text-primary' : 'text-slate-400 hover:text-slate-200'}">
					<input type="radio" name="content-mode" value="text" bind:group={contentMode} class="sr-only" />
					<i class="fa-solid fa-align-left"></i>
					{t("content_mode_text")}
				</label>
			</li>
			<li class="flex-1 border-r border-slate-700">
				<label class="flex w-full cursor-pointer items-center justify-center gap-1.5 px-2 py-2.5 sm:gap-2 sm:px-3 {contentMode === 'markdown' ? 'text-primary' : 'text-slate-400 hover:text-slate-200'}">
					<input type="radio" name="content-mode" value="markdown" bind:group={contentMode} class="sr-only" />
					<i class="fa-brands fa-markdown"></i>
					{t("content_mode_markdown")}
				</label>
			</li>
			<li class="flex-1">
				<label class="flex w-full cursor-pointer items-center justify-center gap-1.5 px-2 py-2.5 sm:gap-2 sm:px-3 {contentMode === 'secret' ? 'text-primary' : 'text-slate-400 hover:text-slate-200'}">
					<input type="radio" name="content-mode" value="secret" bind:group={contentMode} class="sr-only" />
					<i class="fa-solid fa-key"></i>
					{t("content_mode_secret")}
				</label>
			</li>
		</ul>

		<div>
			{#if contentMode === "secret"}
				<PasswordGenerator bind:value={text} />
			{:else if contentMode === "markdown"}
				<MarkdownEditor bind:value={text} maxlength={MAX_TEXT_SIZE} placeholder={t("text_placeholder")} />
			{:else}
				<textarea
					id="note-text"
					bind:value={text}
					placeholder={t("text_placeholder")}
					rows="6"
					maxlength={MAX_TEXT_SIZE}
					class="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-white placeholder-slate-500 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
				></textarea>
			{/if}
			{#if contentMode !== "secret"}
				<p class="mt-1 text-xs text-slate-500">
					{t("char_count", { count: text.length.toLocaleString(), max: MAX_TEXT_SIZE.toLocaleString() })}
				</p>
			{/if}
		</div>

		<div>
			<label for="file-upload" class="mb-1 block text-sm font-medium text-slate-300"
				><i class="fa-solid fa-paperclip"></i> {t("files_label")}</label
			>
			<div
				class="relative rounded-lg border-2 border-dashed p-6 text-center transition-colors {isDragging
					? 'border-primary bg-primary/10'
					: 'border-slate-700 hover:border-slate-600'}"
				ondragover={(e) => {
					e.preventDefault();
					isDragging = true;
				}}
				ondragleave={() => {
					isDragging = false;
				}}
				ondrop={handleDrop}
				role="group"
				aria-label={t("files_drop")}
			>
				<input
					id="file-upload"
					type="file"
					multiple
					onchange={handleFileInput}
					class="absolute inset-0 cursor-pointer opacity-0"
				/>
				<p class="text-sm text-slate-400">
					{t("files_drop")}
				</p>
				<p class="mt-1 text-xs text-slate-500">
					{t("files_limit", { count: maxFilesPerNote, size: formatSize(maxFileSize) })}
				</p>
			</div>

			{#if files.length > 0}
				<ul class="mt-3 space-y-2" aria-label={t("attached_files")}>
					{#each files as file, i}
						<li
							class="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-800 px-3 py-2"
						>
							<span class="truncate text-sm text-slate-300"
								>{file.name} ({formatSize(file.size)})</span
							>
							<button
								type="button"
								onclick={() => removeFile(i)}
								class="ml-2 text-slate-500 hover:text-red-400"
								aria-label={t("remove_file", { name: file.name })}
							>
								&times;
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</div>

		<div class="grid grid-cols-1 gap-4 md:grid-cols-3 md:items-end">
			<div>
				<label for="password" class="mb-1 block text-sm font-medium text-slate-300"
					><i class="fa-solid fa-shield-halved"></i> {t("password_label")}</label
				>
				<input
					id="password"
					type="password"
					bind:value={password}
					placeholder={t("password_placeholder")}
					autocomplete="off"
					class="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-white placeholder-slate-500 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
				/>
			</div>

			<div>
				<label for="expires" class="mb-1 block text-sm font-medium text-slate-300"
					><i class="fa-regular fa-clock"></i> {t("expires_label")}</label
				>
				<select
					id="expires"
					bind:value={expiresIn}
					class="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-white focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
				>
					{#each EXPIRATION_OPTIONS as option}
						<option value={option.value}>{t(option.labelKey)}</option>
					{/each}
				</select>
			</div>

			<div>
				<label for="max-reads" class="mb-1 block text-sm font-medium text-slate-300"
					><i class="fa-solid fa-eye"></i> {t("max_reads_label")}</label
				>
				<input
					id="max-reads"
					type="number"
					bind:value={maxReads}
					placeholder={t("max_reads_placeholder")}
					min="0"
					max="1000"
					class="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-white placeholder-slate-500 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
				/>
			</div>
		</div>

		{#if isSubmitting}
			<div class="py-2">
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
			disabled={!mounted || isSubmitting}
			class="w-full rounded-lg bg-primary px-4 py-3 text-sm font-semibold text-white hover:bg-primary-dark disabled:opacity-50 transition-colors"
		>
			{#if !mounted}
				<i class="fa-solid fa-spinner fa-spin"></i> {t("loading")}
			{:else if isSubmitting}
				<i class="fa-solid fa-spinner fa-spin"></i> {t("submitting")}
			{:else}
				<i class="fa-solid fa-lock"></i> {t("submit_button")}
			{/if}
		</button>
	</form>
{/if}

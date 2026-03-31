<script lang="ts">
import type { ContentMode, CreateNoteResponse, NoteFile, NotePayload } from "@secret/shared";
import { EXPIRATION_OPTIONS, MAX_TEXT_SIZE } from "@secret/shared";
import MarkdownEditor from "$lib/components/MarkdownEditor.svelte";
import PasswordGenerator from "$lib/components/PasswordGenerator.svelte";
import ProgressBar from "$lib/components/ProgressBar.svelte";
import { getConfig } from "$lib/config.svelte";
import { t } from "$lib/i18n/index.svelte";
import { createNote, createNoteWithProgress, deleteNote } from "$lib/utils/api";
import { encryptNote } from "$lib/utils/crypto-client";
import { formatSize } from "$lib/utils/format";

let contentMode = $state<ContentMode>("text");
let text = $state("");
let files = $state<File[]>([]);
let password = $state("");
let expiresIn = $state(86400);
let maxReads = $state("1");
let isSubmitting = $state(false);
let error = $state("");
let shareUrl = $state("");
let noteId = $state("");
let deleteToken = $state("");
let qrCodeUrl = $state("");
let copied = $state(false);
let isDeleting = $state(false);
let isDeleted = $state(false);
let isDragging = $state(false);
let uploadProgress = $state<number | null>(null);

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
		const noteFiles: NoteFile[] = [];
		for (const file of files) {
			const buffer = await file.arrayBuffer();
			noteFiles.push({
				name: file.name,
				type: file.type,
				size: file.size,
				data: new Uint8Array(buffer),
			});
		}

		const payload: NotePayload = {
			...(text ? { text, contentMode } : {}),
			...(noteFiles.length > 0 ? { files: noteFiles } : {}),
		};

		const encrypted = await encryptNote(payload, password || undefined);
		const parsedMaxReads = maxReads ? parseInt(maxReads, 10) : 1;

		let response: CreateNoteResponse;
		if (noteFiles.length > 0) {
			const binaryData = Uint8Array.from(atob(encrypted.encryptedData), (c) => c.charCodeAt(0));
			const formData = new FormData();
			formData.append(
				"metadata",
				JSON.stringify({
					clientNonce: encrypted.clientNonce,
					hasPassword: Boolean(password),
					expiresIn,
					fileCount: noteFiles.length,
					maxReads: parsedMaxReads,
					...(encrypted.salt ? { salt: encrypted.salt } : {}),
				}),
			);
			formData.append("data", new Blob([binaryData], { type: "application/octet-stream" }));

			uploadProgress = 0;
			response = await createNoteWithProgress(formData, (loaded, total) => {
				uploadProgress = (loaded / total) * 100;
			});
		} else {
			response = await createNote({
				encryptedData: encrypted.encryptedData,
				clientNonce: encrypted.clientNonce,
				hasPassword: Boolean(password),
				expiresIn,
				fileCount: noteFiles.length,
				maxReads: parsedMaxReads,
				...(encrypted.salt ? { salt: encrypted.salt } : {}),
			});
		}

		const baseUrl = window.location.origin;
		const url = `${baseUrl}/note/${response.id}#${encrypted.keyFragment}`;
		shareUrl = url;
		noteId = response.id;
		deleteToken = response.deleteToken;
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

async function handleDelete() {
	if (!confirm(t("delete_confirm"))) return;

	isDeleting = true;
	try {
		await deleteNote(noteId, deleteToken);
		isDeleted = true;
	} catch (e) {
		error = e instanceof Error ? e.message : t("error_generic");
	} finally {
		isDeleting = false;
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
	noteId = "";
	deleteToken = "";
	qrCodeUrl = "";
	error = "";
	isDeleted = false;
}
</script>

<svelte:head>
	<title>{config.appName} — {t("create_title")}</title>
	<meta name="description" content={t("create_description")} />
	<meta property="og:title" content="{config.appName} — {t("create_title")}" />
	<meta property="og:description" content={t("app_description")} />
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
			</div>
		</div>

		{#if isDeleted}
			<p class="text-sm text-green-400" role="status"><i class="fa-solid fa-check"></i> {t("note_deleted")}</p>
		{/if}

		<button
			onclick={reset}
			class="w-full rounded-lg border border-slate-700 bg-slate-800 px-4 py-3 text-sm font-medium text-white hover:bg-slate-700 transition-colors"
		>
			<i class="fa-solid fa-plus"></i> {t("create_another")}
		</button>

		{#if deleteToken && !isDeleted}
			<button
				onclick={handleDelete}
				disabled={isDeleting}
				class="w-full rounded-lg border border-red-800/50 bg-red-900/20 px-4 py-2.5 text-sm font-medium text-red-300 hover:bg-red-900/40 disabled:opacity-50 transition-colors"
			>
				<i class="fa-solid fa-trash"></i> {isDeleting ? "..." : t("delete_button")}
			</button>
		{/if}
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

		{#if uploadProgress !== null}
			<ProgressBar progress={uploadProgress} label={t("uploading")} />
		{/if}

		<button
			type="submit"
			disabled={isSubmitting}
			class="w-full rounded-lg bg-primary px-4 py-3 text-sm font-semibold text-white hover:bg-primary-dark disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
		>
			{#if isSubmitting}
				<i class="fa-solid fa-spinner fa-spin"></i> {t("submitting")}
			{:else}
				<i class="fa-solid fa-lock"></i> {t("submit_button")}
			{/if}
		</button>
	</form>
{/if}

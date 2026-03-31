<script lang="ts">
import type { CreateNoteResponse, NoteFile, NotePayload } from "@secret/shared";
import { EXPIRATION_OPTIONS, MAX_TEXT_SIZE } from "@secret/shared";
import { toDataURL } from "qrcode";
import { getConfig } from "$lib/config.svelte";
import { createNote, createNoteWithProgress } from "$lib/utils/api";
import { encryptNote } from "$lib/utils/crypto-client";

let text = $state("");
let files = $state<File[]>([]);
let password = $state("");
let burnAfterRead = $state(false);
let expiresIn = $state(86400);
let _isSubmitting = $state(false);
let _error = $state("");
let shareUrl = $state("");
let _qrCodeUrl = $state("");
let _copied = $state(false);
let _isDragging = $state(false);
let _uploadProgress = $state<number | null>(null);

const config = $derived(getConfig());
const maxFileSize = $derived(config.maxFileSize);
const maxFilesPerNote = $derived(config.maxFilesPerNote);

async function _handleSubmit() {
	if (!text && files.length === 0) {
		_error = "Please enter some text or upload files.";
		return;
	}
	if (text.length > MAX_TEXT_SIZE) {
		_error = `Text is too long. Maximum ${String(MAX_TEXT_SIZE / 1024)}KB.`;
		return;
	}

	_error = "";
	_isSubmitting = true;
	_uploadProgress = null;

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
			...(text ? { text } : {}),
			...(noteFiles.length > 0 ? { files: noteFiles } : {}),
		};

		const encrypted = await encryptNote(payload, password || undefined);

		let response: CreateNoteResponse;
		if (noteFiles.length > 0) {
			const binaryData = Uint8Array.from(atob(encrypted.encryptedData), (c) => c.charCodeAt(0));
			const formData = new FormData();
			formData.append(
				"metadata",
				JSON.stringify({
					clientNonce: encrypted.clientNonce,
					hasPassword: Boolean(password),
					burnAfterRead,
					expiresIn,
					fileCount: noteFiles.length,
					...(encrypted.salt ? { salt: encrypted.salt } : {}),
				}),
			);
			formData.append("data", new Blob([binaryData], { type: "application/octet-stream" }));

			_uploadProgress = 0;
			response = await createNoteWithProgress(formData, (loaded, total) => {
				_uploadProgress = (loaded / total) * 100;
			});
		} else {
			response = await createNote({
				encryptedData: encrypted.encryptedData,
				clientNonce: encrypted.clientNonce,
				hasPassword: Boolean(password),
				burnAfterRead,
				expiresIn,
				fileCount: noteFiles.length,
				...(encrypted.salt ? { salt: encrypted.salt } : {}),
			});
		}

		const baseUrl = window.location.origin;
		const url = `${baseUrl}/note/${response.id}#${encrypted.keyFragment}`;
		shareUrl = url;
		_qrCodeUrl = await toDataURL(url, { width: 256, margin: 2 });
	} catch (e) {
		_error = e instanceof Error ? e.message : "An error occurred";
	} finally {
		_isSubmitting = false;
		_uploadProgress = null;
	}
}

function _handleDrop(event: DragEvent) {
	event.preventDefault();
	_isDragging = false;
	const droppedFiles = event.dataTransfer?.files;
	if (droppedFiles) {
		addFiles(Array.from(droppedFiles));
	}
}

function _handleFileInput(event: Event) {
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

function _removeFile(index: number) {
	files = files.filter((_, i) => i !== index);
}

async function _copyToClipboard() {
	try {
		await navigator.clipboard.writeText(shareUrl);
		_copied = true;
		setTimeout(() => {
			_copied = false;
		}, 2000);
	} catch {
		_error = "Failed to copy to clipboard";
	}
}

function _reset() {
	text = "";
	files = [];
	password = "";
	burnAfterRead = false;
	expiresIn = 86400;
	shareUrl = "";
	_qrCodeUrl = "";
	_error = "";
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
					<label for="share-url" class="mb-1 block text-sm text-slate-400">{t("share_label")}</label>
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
							{copied ? t("copied") : t("copy_button")}
						</button>
					</div>
				</div>

				{#if burnAfterRead}
					<p class="text-sm text-amber-400" role="alert">
						{t("burn_warning")}
					</p>
				{/if}

				{#if qrCodeUrl}
					<div class="flex justify-center">
						<img src={qrCodeUrl} alt="QR code for the share link" class="rounded-lg" width="256" height="256" />
					</div>
				{/if}
			</div>
		</div>

		<button
			onclick={reset}
			class="w-full rounded-lg border border-slate-700 bg-slate-800 px-4 py-3 text-sm font-medium text-white hover:bg-slate-700 transition-colors"
		>
			{t("create_another")}
		</button>
	</div>
{:else}
	<form onsubmit={(e) => { e.preventDefault(); handleSubmit(); }} class="space-y-6">
		<h1 class="text-2xl font-bold">{t("create_title")}</h1>
		<p class="text-slate-400">{t("create_description")}</p>

		{#if error}
			<div class="rounded-lg border border-red-800/50 bg-red-900/20 px-4 py-3 text-sm text-red-300" role="alert">
				{error}
			</div>
		{/if}

		<div>
			<label for="note-text" class="mb-1 block text-sm font-medium text-slate-300">{t("text_label")}</label>
			<textarea
				id="note-text"
				bind:value={text}
				placeholder={t("text_placeholder")}
				rows="6"
				maxlength={MAX_TEXT_SIZE}
				class="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-white placeholder-slate-500 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
			></textarea>
			<p class="mt-1 text-xs text-slate-500">{text.length.toLocaleString()} / {MAX_TEXT_SIZE.toLocaleString()} characters</p>
		</div>

		<div>
			<label for="file-upload" class="mb-1 block text-sm font-medium text-slate-300">{t("files_label")}</label>
			<div
				class="relative rounded-lg border-2 border-dashed p-6 text-center transition-colors {isDragging ? 'border-primary bg-primary/10' : 'border-slate-700 hover:border-slate-600'}"
				ondragover={(e) => { e.preventDefault(); isDragging = true; }}
				ondragleave={() => { isDragging = false; }}
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
					Max {String(maxFilesPerNote)} files, {formatSize(maxFileSize)} each
				</p>
			</div>

			{#if files.length > 0}
				<ul class="mt-3 space-y-2" aria-label="Attached files">
					{#each files as file, i}
						<li class="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-800 px-3 py-2">
							<span class="truncate text-sm text-slate-300">{file.name} ({formatSize(file.size)})</span>
							<button
								type="button"
								onclick={() => removeFile(i)}
								class="ml-2 text-slate-500 hover:text-red-400"
								aria-label="Remove {file.name}"
							>
								&times;
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</div>

		<div>
			<label for="password" class="mb-1 block text-sm font-medium text-slate-300">{t("password_label")}</label>
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
			<label for="expires" class="mb-1 block text-sm font-medium text-slate-300">{t("expires_label")}</label>
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

		<label class="flex items-center gap-3 cursor-pointer">
			<input
				type="checkbox"
				bind:checked={burnAfterRead}
				class="h-4 w-4 rounded border-slate-600 bg-slate-800 text-primary focus:ring-primary"
			/>
			<span class="text-sm text-slate-300">{t("burn_label")}</span>
		</label>

		{#if uploadProgress !== null}
			<ProgressBar progress={uploadProgress} label={t("uploading")} />
		{/if}

		<button
			type="submit"
			disabled={isSubmitting}
			class="w-full rounded-lg bg-primary px-4 py-3 text-sm font-semibold text-white hover:bg-primary-dark disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
		>
			{isSubmitting ? t("submitting") : t("submit_button")}
		</button>
	</form>
{/if}

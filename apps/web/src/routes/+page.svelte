<script lang="ts">
	import { EXPIRATION_OPTIONS, MAX_TEXT_SIZE, MAX_FILE_SIZE, MAX_FILES_PER_NOTE } from "@secret/shared";
	import type { NotePayload, NoteFile } from "@secret/shared";
	import { encryptNote } from "$lib/utils/crypto-client";
	import { createNote } from "$lib/utils/api";
	import { toDataURL } from "qrcode";

	let text = $state("");
	let files = $state<File[]>([]);
	let password = $state("");
	let burnAfterRead = $state(false);
	let expiresIn = $state(86400);
	let isSubmitting = $state(false);
	let error = $state("");
	let shareUrl = $state("");
	let qrCodeUrl = $state("");
	let copied = $state(false);
	let isDragging = $state(false);

	async function handleSubmit() {
		if (!text && files.length === 0) {
			error = "Please enter some text or upload files.";
			return;
		}
		if (text.length > MAX_TEXT_SIZE) {
			error = `Text is too long. Maximum ${String(MAX_TEXT_SIZE / 1024)}KB.`;
			return;
		}

		error = "";
		isSubmitting = true;

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

			const payload: NotePayload = {};
			if (text) payload.text = text;
			if (noteFiles.length > 0) (payload as { files: NoteFile[] }).files = noteFiles;

			const encrypted = await encryptNote(payload, password || undefined);
			const response = await createNote({
				encryptedData: encrypted.encryptedData,
				clientNonce: encrypted.clientNonce,
				hasPassword: Boolean(password),
				burnAfterRead,
				expiresIn,
				fileCount: noteFiles.length,
				salt: encrypted.salt,
			});

			const baseUrl = window.location.origin;
			const url = `${baseUrl}/note/${response.id}#${encrypted.keyFragment}`;
			shareUrl = url;
			qrCodeUrl = await toDataURL(url, { width: 256, margin: 2 });
		} catch (e) {
			error = e instanceof Error ? e.message : "An error occurred";
		} finally {
			isSubmitting = false;
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
		const validFiles = newFiles.filter((f) => f.size <= MAX_FILE_SIZE);
		const remaining = MAX_FILES_PER_NOTE - files.length;
		files = [...files, ...validFiles.slice(0, remaining)];
	}

	function removeFile(index: number) {
		files = files.filter((_, i) => i !== index);
	}

	async function copyToClipboard() {
		await navigator.clipboard.writeText(shareUrl);
		copied = true;
		setTimeout(() => { copied = false; }, 2000);
	}

	function reset() {
		text = "";
		files = [];
		password = "";
		burnAfterRead = false;
		expiresIn = 86400;
		shareUrl = "";
		qrCodeUrl = "";
		error = "";
	}

	function formatSize(bytes: number): string {
		if (bytes < 1024) return `${String(bytes)} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}
</script>

<svelte:head>
	<title>Secret — Secure Note Sharing</title>
	<meta name="description" content="Share encrypted notes and files securely. Zero-knowledge encryption — the server never sees your data." />
	<meta property="og:title" content="Secret — Secure Note Sharing" />
	<meta property="og:description" content="Share encrypted notes and files securely." />
</svelte:head>

{#if shareUrl}
	<div class="space-y-6">
		<div class="rounded-xl border border-green-800/50 bg-green-900/20 p-6">
			<h2 class="mb-4 text-lg font-semibold text-green-300">Note created successfully</h2>

			<div class="space-y-4">
				<div>
					<label for="share-url" class="mb-1 block text-sm text-slate-400">Share this link:</label>
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
							aria-label="Copy link to clipboard"
						>
							{copied ? "Copied!" : "Copy"}
						</button>
					</div>
				</div>

				{#if burnAfterRead}
					<p class="text-sm text-amber-400" role="alert">
						This note will be destroyed after the first read.
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
			Create another note
		</button>
	</div>
{:else}
	<form onsubmit={(e) => { e.preventDefault(); handleSubmit(); }} class="space-y-6">
		<h1 class="text-2xl font-bold">Create a secure note</h1>
		<p class="text-slate-400">Your content is encrypted in your browser before being sent to the server. The server never sees your data.</p>

		{#if error}
			<div class="rounded-lg border border-red-800/50 bg-red-900/20 px-4 py-3 text-sm text-red-300" role="alert">
				{error}
			</div>
		{/if}

		<div>
			<label for="note-text" class="mb-1 block text-sm font-medium text-slate-300">Text content</label>
			<textarea
				id="note-text"
				bind:value={text}
				placeholder="Enter your secret note here..."
				rows="6"
				maxlength={MAX_TEXT_SIZE}
				class="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-white placeholder-slate-500 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
			></textarea>
			<p class="mt-1 text-xs text-slate-500">{text.length.toLocaleString()} / {MAX_TEXT_SIZE.toLocaleString()} characters</p>
		</div>

		<div>
			<label class="mb-1 block text-sm font-medium text-slate-300">Files</label>
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="relative rounded-lg border-2 border-dashed p-6 text-center transition-colors {isDragging ? 'border-primary bg-primary/10' : 'border-slate-700 hover:border-slate-600'}"
				ondragover={(e) => { e.preventDefault(); isDragging = true; }}
				ondragleave={() => { isDragging = false; }}
				ondrop={handleDrop}
				role="region"
				aria-label="File drop zone"
			>
				<input
					type="file"
					multiple
					onchange={handleFileInput}
					class="absolute inset-0 cursor-pointer opacity-0"
					aria-label="Upload files"
				/>
				<p class="text-sm text-slate-400">
					Drag & drop files here or click to browse
				</p>
				<p class="mt-1 text-xs text-slate-500">
					Max {String(MAX_FILES_PER_NOTE)} files, {formatSize(MAX_FILE_SIZE)} each
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
			<label for="password" class="mb-1 block text-sm font-medium text-slate-300">Password protection (optional)</label>
			<input
				id="password"
				type="password"
				bind:value={password}
				placeholder="Add a password for extra security"
				autocomplete="off"
				class="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-white placeholder-slate-500 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
			/>
		</div>

		<div>
			<label for="expires" class="mb-1 block text-sm font-medium text-slate-300">Expires in</label>
			<select
				id="expires"
				bind:value={expiresIn}
				class="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-white focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
			>
				{#each EXPIRATION_OPTIONS as option}
					<option value={option.value}>{option.label}</option>
				{/each}
			</select>
		</div>

		<label class="flex items-center gap-3 cursor-pointer">
			<input
				type="checkbox"
				bind:checked={burnAfterRead}
				class="h-4 w-4 rounded border-slate-600 bg-slate-800 text-primary focus:ring-primary"
			/>
			<span class="text-sm text-slate-300">Burn after read (destroy after first view)</span>
		</label>

		<button
			type="submit"
			disabled={isSubmitting}
			class="w-full rounded-lg bg-primary px-4 py-3 text-sm font-semibold text-white hover:bg-primary-dark disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
		>
			{isSubmitting ? "Encrypting..." : "Create encrypted note"}
		</button>
	</form>
{/if}

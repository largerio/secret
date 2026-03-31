<script lang="ts">
	import { page } from "$app/state";
	import { onMount } from "svelte";
	import type { NotePayload } from "@secret/shared";
	import { checkNoteExists, readNote } from "$lib/utils/api";
	import { decryptNote } from "$lib/utils/crypto-client";
	import { formatSize } from "$lib/utils/format";
	import { marked } from "marked";
	import DOMPurify from "isomorphic-dompurify";

	type NoteStatus =
		| { state: "loading" }
		| { state: "not_found" }
		| { state: "ready"; hasPassword: boolean; burnAfterRead: boolean; fileCount: number; expiresAt: string }
		| { state: "decrypting" }
		| { state: "decrypted"; payload: NotePayload; previewUrls: string[] }
		| { state: "error"; message: string };

	let status = $state<NoteStatus>({ state: "loading" });
	let password = $state("");
	let keyFragment = $state("");

	onMount(() => {
		keyFragment = window.location.hash.slice(1);
		checkNote();

		return () => {
			if (status.state === "decrypted") {
				for (const url of status.previewUrls) {
					URL.revokeObjectURL(url);
				}
			}
		};
	});

	async function checkNote() {
		const id = page.params["id"];
		if (!id || !keyFragment) {
			status = { state: "not_found" };
			return;
		}

		try {
			const result = await checkNoteExists(id);
			if (!result.exists) {
				status = { state: "not_found" };
			} else {
				status = {
					state: "ready",
					hasPassword: result.hasPassword,
					burnAfterRead: result.burnAfterRead,
					fileCount: result.fileCount,
					expiresAt: result.expiresAt,
				};
			}
		} catch {
			status = { state: "error", message: "Failed to check note" };
		}
	}

	async function handleDecrypt() {
		const id = page.params["id"];
		if (!id) return;

		status = { state: "decrypting" };

		try {
			const note = await readNote(id);
			const payload = await decryptNote(
				note.encryptedData,
				note.clientNonce,
				keyFragment,
				password || undefined,
				note.salt,
			);

			const previewUrls: string[] = [];
			if (payload.files) {
				for (const file of payload.files) {
					if (isPreviewable(file.type)) {
						const url = URL.createObjectURL(new Blob([new Uint8Array(file.data as ArrayLike<number>)], { type: file.type }));
						previewUrls.push(url);
					} else {
						previewUrls.push("");
					}
				}
			}

			status = { state: "decrypted", payload, previewUrls };
		} catch (e) {
			const message = e instanceof Error ? e.message : "Decryption failed";
			status = { state: "error", message: message.includes("wrong") || message.includes("ciphertext") ? "Wrong password or invalid key" : message };
		}
	}

	function renderMarkdown(text: string): string {
		const raw = marked.parse(text, { async: false }) as string;
		return DOMPurify.sanitize(raw);
	}

	function downloadFile(name: string, type: string, data: Uint8Array) {
		const blob = new Blob([data], { type });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = name;
		a.click();
		URL.revokeObjectURL(url);
	}

	function isPreviewable(type: string): boolean {
		return type.startsWith("image/") || type.startsWith("video/") || type.startsWith("audio/") || type === "application/pdf";
	}

	function isImage(type: string): boolean {
		return type.startsWith("image/");
	}

	function isVideo(type: string): boolean {
		return type.startsWith("video/");
	}

	function isAudio(type: string): boolean {
		return type.startsWith("audio/");
	}

	function isPdf(type: string): boolean {
		return type === "application/pdf";
	}
</script>

<svelte:head>
	<title>Secret — View Note</title>
	<meta property="og:title" content="Secret — Encrypted Note" />
	<meta property="og:description" content="Click to decrypt this secure note" />
</svelte:head>

<div class="space-y-6">
	{#if status.state === "loading"}
		<div class="flex items-center justify-center py-12" role="status" aria-label="Loading">
			<div class="h-8 w-8 animate-spin rounded-full border-2 border-slate-600 border-t-primary"></div>
		</div>

	{:else if status.state === "not_found"}
		<div class="rounded-xl border border-slate-700 bg-slate-900 p-8 text-center">
			<h1 class="text-xl font-semibold text-slate-300">Note not found</h1>
			<p class="mt-2 text-slate-500">This note may have expired, been deleted, or never existed.</p>
			<a href="/" class="mt-4 inline-block rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark transition-colors">
				Create a new note
			</a>
		</div>

	{:else if status.state === "ready"}
		<div class="rounded-xl border border-slate-700 bg-slate-900 p-6 space-y-4">
			<h1 class="text-xl font-semibold">Encrypted note</h1>
			<p class="text-sm text-slate-400">This note is encrypted. Click the button below to decrypt it in your browser.</p>

			{#if status.burnAfterRead}
				<div class="rounded-lg border border-amber-800/50 bg-amber-900/20 px-4 py-3 text-sm text-amber-300" role="alert">
					This note will be <strong>destroyed</strong> after you read it.
				</div>
			{/if}

			<p class="text-xs text-slate-500">
				Expires: {new Date(status.expiresAt).toLocaleString()}
				{#if status.fileCount > 0}
					&bull; {String(status.fileCount)} file{status.fileCount > 1 ? "s" : ""} attached
				{/if}
			</p>

			{#if status.hasPassword}
				<div>
					<label for="decrypt-password" class="mb-1 block text-sm font-medium text-slate-300">Password required</label>
					<input
						id="decrypt-password"
						type="password"
						bind:value={password}
						placeholder="Enter the password"
						autocomplete="off"
						class="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-white placeholder-slate-500 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
						onkeydown={(e) => { if (e.key === "Enter") handleDecrypt(); }}
					/>
				</div>
			{/if}

			<button
				onclick={handleDecrypt}
				class="w-full rounded-lg bg-primary px-4 py-3 text-sm font-semibold text-white hover:bg-primary-dark transition-colors"
			>
				Decrypt note
			</button>
		</div>

	{:else if status.state === "decrypting"}
		<div class="flex items-center justify-center py-12" role="status" aria-label="Decrypting">
			<div class="h-8 w-8 animate-spin rounded-full border-2 border-slate-600 border-t-primary"></div>
			<span class="ml-3 text-slate-400">Decrypting...</span>
		</div>

	{:else if status.state === "decrypted"}
		<div class="space-y-6">
			{#if status.payload.text}
				<div class="rounded-xl border border-slate-700 bg-slate-900 p-6">
					<h2 class="mb-3 text-sm font-medium text-slate-400">Text content</h2>
					<div class="prose prose-invert prose-sm max-w-none">
						{@html renderMarkdown(status.payload.text)}
					</div>
				</div>
			{/if}

			{#if status.payload.files && status.payload.files.length > 0}
				<div class="space-y-4">
					<h2 class="text-sm font-medium text-slate-400">
						{String(status.payload.files.length)} file{status.payload.files.length > 1 ? "s" : ""}
					</h2>

					{#each status.payload.files as file, i}
						<div class="rounded-xl border border-slate-700 bg-slate-900 overflow-hidden">
							{#if isImage(file.type) && status.previewUrls[i]}
								<img
									src={status.previewUrls[i]}
									alt={file.name}
									class="max-h-96 w-full object-contain bg-slate-800"
								/>
							{:else if isVideo(file.type) && status.previewUrls[i]}
								<video
									controls
									class="max-h-96 w-full bg-slate-800"
									aria-label={file.name}
								>
									<source src={status.previewUrls[i]} type={file.type} />
									<track kind="captions" />
								</video>
							{:else if isAudio(file.type) && status.previewUrls[i]}
								<audio
									controls
									class="w-full p-4"
									aria-label={file.name}
								>
									<source src={status.previewUrls[i]} type={file.type} />
								</audio>
							{:else if isPdf(file.type) && status.previewUrls[i]}
								<iframe
									src={status.previewUrls[i]}
									class="h-96 w-full"
									title={file.name}
									sandbox="allow-same-origin"
								></iframe>
							{/if}

							<div class="flex items-center justify-between p-4">
								<div>
									<p class="font-medium text-slate-200">{file.name}</p>
									<p class="text-xs text-slate-500">{file.type} &bull; {formatSize(file.size)}</p>
								</div>
								<button
									onclick={() => downloadFile(file.name, file.type, new Uint8Array(file.data as ArrayLike<number>))}
									class="rounded-lg border border-slate-600 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800 transition-colors"
								>
									Download
								</button>
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</div>

	{:else if status.state === "error"}
		<div class="rounded-xl border border-red-800/50 bg-red-900/20 p-6 text-center">
			<h1 class="text-lg font-semibold text-red-300">Error</h1>
			<p class="mt-2 text-sm text-red-400">{status.message}</p>
			<a href="/" class="mt-4 inline-block rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark transition-colors">
				Create a new note
			</a>
		</div>
	{/if}
</div>

<script lang="ts">
import type { NotePayload } from "@secret/shared";
import DOMPurify from "isomorphic-dompurify";
import { marked } from "marked";
import { onMount } from "svelte";
import { page } from "$app/state";
import ProgressBar from "$lib/components/ProgressBar.svelte";
import { getConfig } from "$lib/config.svelte";
import { t } from "$lib/i18n/index.svelte";
import { checkNoteExists, readNoteWithProgress } from "$lib/utils/api";
import { decryptNote } from "$lib/utils/crypto-client";
import { formatSize } from "$lib/utils/format";

type NoteStatus =
	| { state: "loading" }
	| { state: "not_found" }
	| {
			state: "ready";
			hasPassword: boolean;
			maxReads: number;
			fileCount: number;
			expiresAt: string;
	  }
	| { state: "downloading"; progress: number }
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
				maxReads: result.maxReads,
				fileCount: result.fileCount,
				expiresAt: result.expiresAt,
			};
		}
	} catch {
		status = { state: "error", message: t("error_check_note") };
	}
}

async function handleDecrypt() {
	const id = page.params["id"];
	if (!id) return;

	status = { state: "downloading", progress: 0 };

	try {
		const note = await readNoteWithProgress(id, (loaded, total) => {
			if (status.state === "downloading") {
				status = { state: "downloading", progress: (loaded / total) * 100 };
			}
		});

		status = { state: "decrypting" };

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
					const url = URL.createObjectURL(
						new Blob([new Uint8Array(file.data as ArrayLike<number>)] as BlobPart[], {
							type: file.type,
						}),
					);
					previewUrls.push(url);
				} else {
					previewUrls.push("");
				}
			}
		}

		status = { state: "decrypted", payload, previewUrls };
	} catch (e) {
		const message = e instanceof Error ? e.message : t("error_decryption");
		status = {
			state: "error",
			message:
				message.includes("wrong") || message.includes("ciphertext")
					? t("error_wrong_password")
					: message,
		};
	}
}

function renderMarkdown(text: string): string {
	const raw = marked.parse(text, { async: false }) as string;
	return DOMPurify.sanitize(raw);
}

function downloadFile(name: string, type: string, data: Uint8Array) {
	const blob = new Blob([data] as BlobPart[], { type });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = name;
	a.click();
	URL.revokeObjectURL(url);
}

function isPreviewable(type: string): boolean {
	return (
		type.startsWith("image/") ||
		type.startsWith("video/") ||
		type.startsWith("audio/") ||
		type === "application/pdf"
	);
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
	<title>{getConfig().appName} — {t("view_title")}</title>
	<meta name="robots" content="noindex, nofollow" />
	<meta name="description" content={t("view_description")} />
	<meta property="og:title" content="{getConfig().appName} — {t("view_title")}" />
	<meta property="og:description" content={t("view_description")} />
</svelte:head>

<div class="space-y-6">
	{#if status.state === "loading"}
		<div class="flex items-center justify-center py-12" role="status" aria-label={t("loading")}>
			<div class="h-8 w-8 animate-spin rounded-full border-2 border-slate-600 border-t-primary"></div>
		</div>

	{:else if status.state === "not_found"}
		<div class="rounded-xl border border-slate-700 bg-slate-900 p-8 text-center">
			<h1 class="text-xl font-semibold text-slate-300">{t("not_found_title")}</h1>
			<p class="mt-2 text-slate-500">{t("not_found_description")}</p>
			<a href="/" class="mt-4 inline-block rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark transition-colors">
				{t("new_note")}
			</a>
		</div>

	{:else if status.state === "ready"}
		<div class="rounded-xl border border-slate-700 bg-slate-900 p-6 space-y-4">
			<h1 class="text-xl font-semibold">{t("view_title")}</h1>
			<p class="text-sm text-slate-400">{t("view_description")}</p>

			{#if status.maxReads === 1}
				<div class="rounded-lg border border-amber-800/50 bg-amber-900/20 px-4 py-3 text-sm text-amber-300" role="alert">
					{t("view_burn_warning")}
				</div>
			{/if}

			<p class="text-xs text-slate-500">
				{t("expires")} {new Date(status.expiresAt).toLocaleString()}
				{#if status.fileCount > 0}
					&bull; {t("files_count", { count: status.fileCount })}
				{/if}
			</p>

			{#if status.hasPassword}
				<div>
					<label for="decrypt-password" class="mb-1 block text-sm font-medium text-slate-300">{t("view_password_label")}</label>
					<input
						id="decrypt-password"
						type="password"
						bind:value={password}
						placeholder={t("view_password_placeholder")}
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
				{t("decrypt_button")}
			</button>
		</div>

	{:else if status.state === "downloading"}
		<div class="flex flex-col items-center justify-center gap-4 py-12" role="status" aria-label={t("downloading")}>
			<div class="h-8 w-8 animate-spin rounded-full border-2 border-slate-600 border-t-primary"></div>
			<div class="w-64">
				<ProgressBar progress={status.progress} label={t("downloading")} />
			</div>
		</div>

	{:else if status.state === "decrypting"}
		<div class="flex items-center justify-center py-12" role="status" aria-label={t("decrypting")}>
			<div class="h-8 w-8 animate-spin rounded-full border-2 border-slate-600 border-t-primary"></div>
			<span class="ml-3 text-slate-400">{t("decrypting")}</span>
		</div>

	{:else if status.state === "decrypted"}
		<div class="space-y-6">
			{#if status.payload.text}
				<div class="rounded-xl border border-slate-700 bg-slate-900 p-6">
					<h2 class="mb-3 text-sm font-medium text-slate-400">{t("text_content")}</h2>
					{#if status.payload.contentMode === "markdown" || !status.payload.contentMode}
						<div class="prose prose-invert prose-sm max-w-none">
							{@html renderMarkdown(status.payload.text)}
						</div>
					{:else if status.payload.contentMode === "secret"}
						<code class="block rounded-lg bg-slate-800 px-4 py-3 font-mono text-sm text-white break-all select-all">{status.payload.text}</code>
					{:else}
						<pre class="whitespace-pre-wrap text-sm text-slate-200">{status.payload.text}</pre>
					{/if}
				</div>
			{/if}

			{#if status.payload.files && status.payload.files.length > 0}
				<div class="space-y-4">
					<h2 class="text-sm font-medium text-slate-400">
						{t("files_count", { count: status.payload.files.length })}
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
									{t("download")}
								</button>
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</div>

	{:else if status.state === "error"}
		<div class="rounded-xl border border-red-800/50 bg-red-900/20 p-6 text-center">
			<h1 class="text-lg font-semibold text-red-300">{t("error_title")}</h1>
			<p class="mt-2 text-sm text-red-400">{status.message}</p>
			<a href="/" class="mt-4 inline-block rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark transition-colors">
				{t("new_note")}
			</a>
		</div>
	{/if}
</div>

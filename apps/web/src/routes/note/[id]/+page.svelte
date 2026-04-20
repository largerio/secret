<script lang="ts">
import type { NotePayload } from "@secret/shared";
import DOMPurify from "isomorphic-dompurify";
import { marked } from "marked";
import { onMount } from "svelte";
import { fade, fly } from "svelte/transition";
import { page } from "$app/state";
import StepProgress from "$lib/components/StepProgress.svelte";
import { getClient } from "$lib/client";
import { getConfig } from "$lib/config.svelte";
import { formatDateTime, t } from "$lib/i18n/index.svelte";
import { formatSize } from "$lib/utils/format";

interface NoteInfo {
	hasPassword: boolean;
	maxReads: number;
	fileCount: number;
	expiresAt: string;
	chunked: boolean;
}

type NoteStatus =
	| { state: "not_found" }
	| { state: "ready"; info: NoteInfo }
	| { state: "downloading"; progress: number }
	| { state: "decrypting" }
	| { state: "decrypted"; payload: NotePayload; previewUrls: string[] }
	| { state: "error"; message: string };

const { data } = $props();

let status = $state<NoteStatus>(
	data.noteInfo ? { state: "ready", info: data.noteInfo } : { state: "not_found" },
);
let mounted = $state(false);
let password = $state("");
let keyFragment = $state("");
let copied = $state(false);

async function copyText(text: string) {
	try {
		await navigator.clipboard.writeText(text);
		copied = true;
		setTimeout(() => {
			copied = false;
		}, 2000);
	} catch {
		/* clipboard API unavailable */
	}
}

onMount(() => {
	keyFragment = window.location.hash.slice(1);
	mounted = true;

	if (!keyFragment) {
		status = { state: "not_found" };
	}

	return () => {
		if (status.state === "decrypted") {
			for (const url of status.previewUrls) {
				URL.revokeObjectURL(url);
			}
		}
	};
});

async function handleDecrypt() {
	const id = page.params["id"];
	if (!id || status.state !== "ready") return;

	const chunked = status.info.chunked;
	status = { state: "downloading", progress: 0 };

	try {
		const client = await getClient();
		const result = await client.readNote(id, keyFragment, {
			...(password ? { password } : {}),
			chunked,
			onDownloadProgress: (p) => {
				if (status.state === "downloading") {
					status = { state: "downloading", progress: p * 100 };
				}
			},
			onProgress: (info) => {
				if (info.phase === "downloading" && status.state === "downloading") {
					status = { state: "downloading", progress: info.phaseProgress * 100 };
				} else if (info.phase === "decrypting") {
					status = { state: "decrypting" };
				}
			},
		});

		status = { state: "decrypting" };

		const { payload } = result;
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
		const raw = e instanceof Error ? e.message : "";
		const isWrongPassword =
			raw.includes("wrong") || raw.includes("ciphertext") || raw.includes("decrypt");
		status = {
			state: "error",
			message: isWrongPassword ? t("error_wrong_password") : t("error_decryption"),
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
	{#if status.state === "not_found"}
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

			{#if status.info.maxReads === 1}
				<div class="rounded-lg border border-amber-800/50 bg-amber-900/20 px-4 py-3 text-sm text-amber-300" role="alert">
					{t("view_burn_warning")}
				</div>
			{/if}

			<p class="text-xs text-slate-500">
				{t("expires")} {formatDateTime(status.info.expiresAt)}
				{#if status.info.fileCount > 0}
					&bull; {t("files_count", { count: status.info.fileCount })}
				{/if}
			</p>

			{#if status.info.hasPassword}
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
				disabled={!mounted}
				class="w-full rounded-lg bg-primary px-4 py-3 text-sm font-semibold text-white hover:bg-primary-dark disabled:opacity-50 transition-colors"
			>
				{#if !mounted}
					<i class="fa-solid fa-spinner fa-spin"></i> {t("loading")}
				{:else}
					{t("decrypt_button")}
				{/if}
			</button>
		</div>

	{:else if status.state === "downloading" || status.state === "decrypting"}
		<div class="flex flex-col items-center justify-center gap-6 py-12" role="status">
			<div class="w-72">
				<StepProgress
					steps={[
						{ key: "downloading", label: t("downloading"), icon: "fa-solid fa-cloud-arrow-down" },
						{ key: "decrypting", label: t("decrypting"), icon: "fa-solid fa-lock-open" },
						{ key: "done", label: t("done"), icon: "fa-solid fa-check" },
					]}
					currentStep={status.state === "downloading" ? 0 : 1}
					progress={status.state === "downloading" ? status.progress : 100}
				/>
			</div>
		</div>

	{:else if status.state === "decrypted"}
		<div class="space-y-6" in:fade={{ duration: 200 }}>
			{#if status.payload.text}
				<div class="rounded-xl border border-slate-700 bg-slate-900 p-6" in:fly={{ y: 20, duration: 300 }}>
					<div class="mb-3 flex items-center justify-between">
						<h2 class="text-sm font-medium text-slate-400">{t("text_content")}</h2>
						<button
							onclick={() => copyText(status.state === "decrypted" ? status.payload.text ?? "" : "")}
							class="rounded-md px-2 py-1 text-sm text-slate-400 hover:text-white hover:bg-slate-700 transition-colors"
							aria-label={t("copy_button")}
						>
							{#if copied}
								<i class="fa-solid fa-check text-green-400"></i>
							{:else}
								<i class="fa-regular fa-copy"></i>
							{/if}
						</button>
					</div>
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
						<div class="rounded-xl border border-slate-700 bg-slate-900 overflow-hidden" in:fly={{ y: 20, duration: 300, delay: Math.min(150 * i, 600) }}>
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
									sandbox=""
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
		<div class="rounded-xl border border-red-800/50 bg-red-900/20 p-6 text-center" in:fade={{ duration: 200 }}>
			<h1 class="text-lg font-semibold text-red-300">{t("error_title")}</h1>
			<p class="mt-2 text-sm text-red-400">{status.message}</p>
			<a href="/" class="mt-4 inline-block rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark transition-colors">
				{t("new_note")}
			</a>
		</div>
	{/if}
</div>

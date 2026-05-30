<script lang="ts">
import { SecretDecryptionError } from "@secret/sdk-js";
import type { NotePayload } from "@secret/shared";
import { onMount } from "svelte";
import { fade, fly } from "svelte/transition";
import { page } from "$app/state";
import Icon from "$lib/components/Icon.svelte";
import StepProgress from "$lib/components/StepProgress.svelte";
import { getClient } from "$lib/client";
import { getConfig } from "$lib/config.svelte";
import { formatDateTime, t } from "$lib/i18n/index.svelte";
import { setStep } from "$lib/steps.svelte";
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
let wrongPassword = $state(false);
let burnAccepted = $state(false);
let pwShake = $state(false);
let pwInputEl: HTMLInputElement | undefined = $state();
let renderedMarkdown = $state("");

$effect(() => {
	if (status.state !== "decrypted" || status.payload.contentMode !== "markdown") {
		renderedMarkdown = "";
		return;
	}
	const text = status.payload.text ?? "";
	let cancelled = false;
	(async () => {
		const [{ marked }, DOMPurify] = await Promise.all([
			import("marked"),
			import("isomorphic-dompurify"),
		]);
		if (cancelled) return;
		const raw = marked.parse(text, { async: false }) as string;
		renderedMarkdown = DOMPurify.default.sanitize(raw);
	})();
	return () => {
		cancelled = true;
	};
});

$effect(() => {
	if (status.state === "decrypted") setStep(4);
	else setStep(3);
});

const isBurn = $derived.by(() => {
	if (status.state === "ready") return status.info.maxReads === 1;
	return false;
});

const needsPassword = $derived.by(() => {
	if (status.state === "ready") return status.info.hasPassword;
	return false;
});

const showPwInput = $derived(
	status.state === "ready" && needsPassword && (!isBurn || burnAccepted),
);
const showPrimaryCta = $derived(status.state === "ready" && (!isBurn || burnAccepted));

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
	wrongPassword = false;

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
		// A decryption failure (wrong password/key or corrupted data) surfaces as
		// a single typed error — we cannot tell which, by design. When the note is
		// password-protected, offer another attempt; otherwise it's unrecoverable.
		if (e instanceof SecretDecryptionError && data.noteInfo?.hasPassword) {
			wrongPassword = true;
			pwShake = true;
			status = { state: "ready", info: data.noteInfo };
			setTimeout(() => {
				pwShake = false;
				pwInputEl?.focus();
			}, 450);
		} else {
			status = { state: "error", message: t("error_decryption") };
		}
	}
}

function downloadFile(name: string, type: string, d: Uint8Array) {
	const blob = new Blob([d] as BlobPart[], { type });
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

{#if status.state === "not_found"}
	<section
		class="rounded-2xl border"
		style:background="var(--bg-2)"
		style:border-color="var(--line)"
		style:padding="40px 32px"
		style:text-align="center"
	>
		<h1 class="serif" style:font-size="32px" style:margin="0 0 12px">
			{t("not_found_title")}
		</h1>
		<p style:color="var(--muted)" style:margin="0 0 24px">{t("not_found_description")}</p>
		<a
			href="/"
			class="inline-flex items-center gap-2 rounded-lg transition-colors"
			style:background="var(--accent)"
			style:color="var(--accent-ink)"
			style:padding="12px 18px"
			style:font-size="14px"
		>
			<Icon name="lock" size={14} />
			<span>{t("new_note")}</span>
		</a>
	</section>
{:else if status.state === "ready"}
	<section>
		<div class="mb-8 flex flex-col items-start">
			<span
				class="mono mb-2 inline-flex items-center gap-1.5 uppercase"
				style:font-size="11px"
				style:letter-spacing="0.12em"
				style:color="var(--muted)"
			>
				<Icon name="lock" size={11} />
				<span>{t("app_description")}</span>
			</span>
			<h1
				class="serif"
				style:font-size="clamp(32px, 5vw, 44px)"
				style:margin="4px 0 20px"
				style:line-height="1.3"
				style:letter-spacing="-0.02em"
				style:font-weight="400"
				style:padding-bottom="8px"
			>
				{t("un_hero_1")}
				<em style:color="var(--accent)">{t("un_hero_2")}</em>
			</h1>
			<p style:color="var(--muted)" style:font-size="15px" style:margin="0">
				{t("un_hero_sub")}
			</p>
		</div>

		{#if isBurn && !burnAccepted}
			<div
				class="mb-6 rounded-2xl border"
				style:background="var(--accent-soft)"
				style:border-color="var(--accent-ring)"
				style:padding="20px 24px"
			>
				<div
					class="mono mb-2 inline-flex items-center gap-1.5 uppercase"
					style:font-size="11px"
					style:letter-spacing="0.12em"
					style:color="var(--accent)"
				>
					<Icon name="flame" size={12} />
					<span>{t("un_burn_title")}</span>
				</div>
				<p style:color="var(--text)" style:font-size="14px" style:margin="0 0 16px" style:line-height="1.5">
					{t("un_burn_body")}
				</p>
				<button
					type="button"
					onclick={() => (burnAccepted = true)}
					class="inline-flex items-center gap-1.5 rounded-lg border-0 transition-all"
					style:background="var(--accent)"
					style:color="var(--accent-ink)"
					style:padding="10px 16px"
					style:font-size="13px"
					style:font-weight="500"
				>
					<Icon name="flame" size={13} />
					<span>{t("un_burn_cta")}</span>
				</button>
			</div>
		{/if}

		{#if showPwInput}
			<div
				class="mb-4 rounded-2xl border"
				style:background="var(--bg-2)"
				style:border-color="var(--line)"
				style:padding="20px 24px"
				style:animation={pwShake ? "shake 0.4s" : "none"}
			>
				<div
					class="mono mb-2 inline-flex items-center gap-1.5 uppercase"
					style:font-size="11px"
					style:letter-spacing="0.12em"
					style:color="var(--muted)"
				>
					<Icon name="key" size={12} />
					<span>{t("un_pw_eyebrow")}</span>
				</div>
				<p style:color="var(--muted)" style:font-size="13px" style:margin="0 0 12px">
					{t("un_pw_hint")}
				</p>
				<input
					bind:this={pwInputEl}
					id="decrypt-password"
					type="password"
					bind:value={password}
					placeholder={t("un_pw_placeholder")}
					autocomplete="off"
					autofocus
					onkeydown={(e) => {
						if (e.key === "Enter") handleDecrypt();
					}}
					class="w-full rounded-xl border outline-none transition-colors"
					style:background="var(--bg-2)"
					style:border-color={wrongPassword ? "var(--accent)" : "var(--line)"}
					style:color="var(--text)"
					style:padding="12px 14px"
					style:font-family="var(--font-mono)"
					style:font-size="14px"
				/>
				{#if wrongPassword}
					<div
						class="mono mt-2 inline-flex items-center gap-1.5"
						style:font-size="12px"
						style:color="var(--accent)"
					>
						<Icon name="warn" size={12} />
						<span>{t("error_wrong_password")}</span>
					</div>
				{/if}
			</div>
		{/if}

		{#if showPrimaryCta}
			<button
				type="button"
				onclick={handleDecrypt}
				disabled={!mounted}
				class="mb-6 inline-flex w-full items-center justify-center gap-2 rounded-xl border-0 transition-all disabled:cursor-not-allowed disabled:opacity-50"
				style:background="var(--accent)"
				style:color="var(--accent-ink)"
				style:padding="16px 24px"
				style:font-size="15px"
				style:font-weight="500"
			>
				<Icon name="unlock" size={16} />
				<span>{t("un_cta")}</span>
			</button>
		{/if}

		<ul
			class="mono m-0 flex list-none flex-col gap-2 p-0"
			style:color="var(--muted-2)"
			style:font-size="11px"
			style:line-height="1.6"
		>
			<li class="flex items-center gap-2">
				<Icon name="shield" size={12} />
				<span>{t("un_info_local")}</span>
			</li>
			{#if isBurn}
				<li class="flex items-center gap-2">
					<Icon name="flame" size={12} />
					<span>{t("un_info_burn")}</span>
				</li>
			{/if}
			<li class="flex items-center gap-2">
				<Icon name="clock" size={12} />
				<span>{t("un_info_expiry", { date: formatDateTime(status.info.expiresAt) })}</span>
			</li>
			{#if status.info.fileCount > 0}
				<li class="flex items-center gap-2">
					<Icon name="paperclip" size={12} />
					<span>{t("files_count", { count: status.info.fileCount })}</span>
				</li>
			{/if}
		</ul>
	</section>
{:else if status.state === "downloading" || status.state === "decrypting"}
	<section
		class="flex flex-col items-center justify-center gap-6"
		style:padding="48px 0"
		role="status"
	>
		<div class="w-72 max-w-full">
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
	</section>
{:else if status.state === "decrypted"}
	<section class="space-y-6" in:fade={{ duration: 200 }}>
		<div class="flex flex-col items-start">
			<span
				class="mono mb-2 inline-flex items-center gap-1.5 uppercase"
				style:font-size="11px"
				style:letter-spacing="0.12em"
				style:color="var(--accent)"
			>
				<Icon name="unlock" size={11} />
				<span>{t("rv_eyebrow")}</span>
			</span>
			<h1
				class="serif"
				style:font-size="clamp(28px, 4vw, 36px)"
				style:margin="4px 0 12px"
				style:line-height="1.3"
				style:letter-spacing="-0.02em"
				style:font-weight="400"
			>
				{t("rv_title")}
			</h1>
		</div>

		{#if status.payload.text}
			<div
				class="overflow-hidden rounded-2xl border"
				style:background="var(--bg-2)"
				style:border-color="var(--line)"
				in:fly={{ y: 20, duration: 300 }}
			>
				<div
					class="flex items-center justify-between border-b"
					style:padding="12px 16px"
					style:border-color="var(--line)"
				>
					<span
						class="mono uppercase"
						style:font-size="11px"
						style:letter-spacing="0.1em"
						style:color="var(--muted)"
					>
						{t("text_content")}
					</span>
					<button
						type="button"
						onclick={() =>
							copyText(status.state === "decrypted" ? (status.payload.text ?? "") : "")}
						class="inline-flex items-center gap-1.5 rounded-md border-0 bg-transparent transition-colors"
						style:color={copied ? "var(--accent)" : "var(--muted)"}
						style:padding="4px 8px"
						style:font-size="12px"
						aria-label={t("copy_button")}
					>
						<Icon name={copied ? "check" : "copy"} size={13} />
						<span>{copied ? t("copied") : t("rv_copy")}</span>
					</button>
				</div>
				<div style:padding="18px 20px">
					{#if status.payload.contentMode === "markdown"}
						<div class="prose prose-invert prose-sm max-w-none">
							{@html renderedMarkdown}
						</div>
					{:else if status.payload.contentMode === "secret"}
						<code
							class="block select-all break-all rounded-lg"
							style:background="var(--bg-3)"
							style:padding="14px 16px"
							style:font-family="var(--font-mono)"
							style:font-size="14px"
							style:color="var(--text)"
							style:line-height="1.5">{status.payload.text}</code
						>
					{:else}
						<pre
							class="whitespace-pre-wrap"
							style:font-family="inherit"
							style:color="var(--text)"
							style:font-size="15px"
							style:line-height="1.7"
							style:margin="0">{status.payload.text}</pre>
					{/if}
				</div>
			</div>
		{/if}

		{#if status.payload.files && status.payload.files.length > 0}
			<div>
				<div
					class="mono mb-3 inline-flex items-center gap-1.5 uppercase"
					style:font-size="11px"
					style:letter-spacing="0.12em"
					style:color="var(--muted)"
				>
					<Icon name="paperclip" size={11} />
					<span>{t("rv_files")} ({status.payload.files.length})</span>
				</div>
				<ul class="m-0 flex list-none flex-col gap-3 p-0">
					{#each status.payload.files as file, i (file.name + i)}
						<li
							class="overflow-hidden rounded-2xl border"
							style:background="var(--bg-2)"
							style:border-color="var(--line)"
							in:fly={{ y: 20, duration: 300, delay: Math.min(150 * i, 600) }}
						>
							{#if isImage(file.type) && status.previewUrls[i]}
								<img
									src={status.previewUrls[i]}
									alt={file.name}
									class="max-h-96 w-full object-contain"
									style:background="var(--bg-3)"
								/>
							{:else if isVideo(file.type) && status.previewUrls[i]}
								<video
									controls
									class="max-h-96 w-full"
									style:background="var(--bg-3)"
									aria-label={file.name}
								>
									<source src={status.previewUrls[i]} type={file.type} />
									<track kind="captions" />
								</video>
							{:else if isAudio(file.type) && status.previewUrls[i]}
								<audio controls class="w-full" style:padding="16px" aria-label={file.name}>
									<source src={status.previewUrls[i]} type={file.type} />
								</audio>
							{:else if isPdf(file.type) && status.previewUrls[i]}
								<iframe src={status.previewUrls[i]} class="h-96 w-full" title={file.name} sandbox=""
								></iframe>
							{/if}
							<div class="flex items-center gap-3" style:padding="14px 16px">
								<Icon name="file" size={16} class="shrink-0" />
								<div class="min-w-0 flex-1">
									<p
										class="mb-0.5 truncate"
										style:font-family="var(--font-mono)"
										style:font-size="13px"
										style:color="var(--text)"
									>
										{file.name}
									</p>
									<p class="mono" style:font-size="11px" style:color="var(--muted-2)">
										{file.type} · {formatSize(file.size)}
									</p>
								</div>
								<button
									type="button"
									onclick={() =>
										downloadFile(
											file.name,
											file.type,
											new Uint8Array(file.data as ArrayLike<number>),
										)}
									class="inline-flex items-center gap-1.5 rounded-lg border transition-colors"
									style:background="var(--bg-3)"
									style:border-color="var(--line)"
									style:color="var(--text)"
									style:padding="8px 12px"
									style:font-size="12px"
								>
									<Icon name="download" size={13} />
									<span>{t("rv_download")}</span>
								</button>
							</div>
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		<div class="flex gap-2">
			<a
				href="/"
				class="inline-flex flex-1 items-center justify-center gap-2 rounded-xl border transition-colors"
				style:background="var(--bg-2)"
				style:border-color="var(--line)"
				style:color="var(--text)"
				style:padding="14px"
				style:font-size="14px"
			>
				<Icon name="lock" size={14} />
				<span>{t("rv_gone_cta")}</span>
			</a>
		</div>
	</section>
{:else if status.state === "error"}
	<section
		class="rounded-2xl border"
		style:background="var(--accent-soft)"
		style:border-color="var(--accent-ring)"
		style:padding="32px"
		style:text-align="center"
		in:fade={{ duration: 200 }}
	>
		<div
			class="mono mb-2 inline-flex items-center gap-1.5 uppercase"
			style:font-size="11px"
			style:letter-spacing="0.12em"
			style:color="var(--accent)"
		>
			<Icon name="warn" size={12} />
			<span>{t("error_title")}</span>
		</div>
		<h1 class="serif" style:font-size="28px" style:margin="4px 0 10px">{status.message}</h1>
		<a
			href="/"
			class="mt-4 inline-flex items-center gap-2 rounded-lg transition-colors"
			style:background="var(--accent)"
			style:color="var(--accent-ink)"
			style:padding="12px 18px"
			style:font-size="14px"
		>
			<Icon name="lock" size={14} />
			<span>{t("new_note")}</span>
		</a>
	</section>
{/if}

<script lang="ts">
import { MAX_TEXT_SIZE } from "@largerio/secret-shared";
import { onMount } from "svelte";
import Composer from "#lib/components/create/Composer.svelte";
import Lifetime from "#lib/components/create/Lifetime.svelte";
import SuccessView from "#lib/components/create/SuccessView.svelte";
import Icon from "#lib/components/Icon.svelte";
import Callout from "#lib/components/ui/Callout.svelte";
import PageHero from "#lib/components/ui/PageHero.svelte";
import ProgressPanel from "#lib/components/ui/ProgressPanel.svelte";
import TrustLine from "#lib/components/ui/TrustLine.svelte";
import { getClient } from "#lib/client.js";
import { getConfig } from "#lib/config.svelte.js";
import { t } from "#lib/i18n/index.svelte.js";
import { defaultExpiration } from "#lib/server-config.js";
import { solveCap } from "#lib/utils/cap.js";
import { resolveContentMode } from "#lib/utils/contentMode.js";
import { DONE, type ProgressView, sendProgress } from "#lib/utils/progress.js";

// How long "Link ready" stays on screen before the link itself replaces it.
const DONE_PAUSE_MS = 450;

const config = $derived(getConfig());
const maxFileSize = $derived(config.maxChunkedFileSize || config.maxFileSize);

let mounted = $state(false);
onMount(() => {
	mounted = true;
});

// The note being written
let text = $state("");
let files = $state<File[]>([]);
let formatted = $state(false);
let generated = $state<string | null>(null);
let expiresIn = $state(defaultExpiration(getConfig().maxExpiry));
let maxReads = $state(1);
let password = $state("");
let passwordOn = $state(false);

// Where the page is: writing, sending, or showing the link
let phase = $state<"compose" | "sending" | "done">("compose");
let progress = $state<ProgressView>({ step: 0, percent: null, chunk: null });
let error = $state("");
let passwordError = $state("");

let result = $state<{
	shareUrl: string;
	manageUrl: string;
	password: string;
	fileCount: number;
} | null>(null);
let linkCopied = $state(false);

const contentMode = $derived(
	resolveContentMode(text, { formatted, generated, hasFiles: files.length > 0 }),
);
const canSubmit = $derived(text.trim().length > 0 || files.length > 0);

const progressLabel = $derived(
	progress.step === 0
		? t("send_encrypting")
		: progress.step === 1
			? t("send_uploading", { percent: progress.percent ?? 0 })
			: t("send_done"),
);
const progressDetail = $derived(
	progress.step === 1 && progress.chunk
		? t("chunk_progress", { current: progress.chunk.current, total: progress.chunk.total })
		: progress.step === 2
			? ""
			: t("key_stays_here"),
);

// Leaving mid-upload loses the note, and leaving the link before copying it
// loses the secret for good: the key exists nowhere else.
$effect(() => {
	const guard = phase === "sending" || (phase === "done" && !linkCopied);
	if (!guard) return;
	const warn = (event: BeforeUnloadEvent) => event.preventDefault();
	window.addEventListener("beforeunload", warn);
	return () => window.removeEventListener("beforeunload", warn);
});

async function handleSubmit(): Promise<void> {
	if (!canSubmit) {
		error = t("error_empty_content");
		return;
	}
	if (text.length > MAX_TEXT_SIZE) {
		error = t("error_text_too_long", { max: String(MAX_TEXT_SIZE / 1024) });
		return;
	}
	// Asked for and left empty would quietly send the note unprotected.
	if (passwordOn && !password.trim()) {
		passwordError = t("error_empty_password");
		return;
	}

	error = "";
	passwordError = "";
	progress = { step: 0, percent: null, chunk: null };
	phase = "sending";
	// The field is only sent while the reader is asked for it.
	const sentPassword = passwordOn ? password : "";

	try {
		const capToken = await solveCap();
		const client = await getClient();
		const noteFiles = await Promise.all(
			files.map(async (file) => ({
				name: file.name,
				type: file.type,
				data: new Uint8Array(await file.arrayBuffer()),
			})),
		);

		const created = await client.createNote({
			...(text ? { text, contentMode } : {}),
			...(noteFiles.length > 0 ? { files: noteFiles } : {}),
			...(sentPassword ? { password: sentPassword } : {}),
			expiresIn,
			maxReads,
			capToken,
			// The instance's CHUNK_SIZE: the API refuses any chunk larger than it,
			// and the SDK knows only its own 4 MiB default.
			chunkSize: config.chunkSize,
			onProgress: (info) => {
				progress = sendProgress(info);
			},
		});

		const origin = window.location.origin;
		result = {
			shareUrl: `${origin}/note/${created.id}#${created.keyFragment}`,
			manageUrl: `${origin}/note/${created.id}/manage#${created.deleteToken}`,
			password: sentPassword,
			fileCount: files.length,
		};
		progress = DONE;
		await new Promise((resolve) => setTimeout(resolve, DONE_PAUSE_MS));
		phase = "done";
	} catch (e) {
		error = e instanceof Error ? e.message : t("error_generic");
		phase = "compose";
	}
}

function reset(): void {
	text = "";
	files = [];
	formatted = false;
	generated = null;
	password = "";
	passwordOn = false;
	passwordError = "";
	expiresIn = defaultExpiration(getConfig().maxExpiry);
	maxReads = 1;
	result = null;
	linkCopied = false;
	error = "";
	phase = "compose";
}
</script>

<svelte:head>
	<title>{t("seo_title", { app: config.appName })}</title>
	<meta name="description" content={t("seo_description")} />
	<meta name="keywords" content={t("seo_keywords")} />
	<link rel="canonical" href={config.appUrl} />
	<meta property="og:title" content={t("seo_title", { app: config.appName })} />
	<meta property="og:description" content={t("seo_description")} />
	<meta property="og:url" content={config.appUrl} />
	<meta name="twitter:title" content={t("seo_title", { app: config.appName })} />
	<meta name="twitter:description" content={t("seo_description")} />
	{@html `<script type="application/ld+json">${JSON.stringify({
		"@context": "https://schema.org",
		"@type": "WebApplication",
		name: config.appName,
		url: config.appUrl,
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

{#if phase === "done" && result}
	<SuccessView
		shareUrl={result.shareUrl}
		manageUrl={result.manageUrl}
		password={result.password}
		fileCount={result.fileCount}
		{expiresIn}
		{maxReads}
		onreset={reset}
		onlinkcopied={() => (linkCopied = true)}
	/>
{:else if phase === "sending"}
	<PageHero title={t("send_title")} sub={t("send_sub")} afterAction />
	<ProgressPanel
		view={progress}
		label={progressLabel}
		detail={progressDetail}
		steps={[t("step_encrypt"), t("step_upload"), t("step_link")]}
	/>
	<p class="m-0 flex items-center justify-center gap-2 text-center text-[12.5px] text-muted">
		<Icon name="alert" size={14} class="shrink-0 text-warn" />{t("send_keep_open")}
	</p>
{:else}
	<PageHero title={t("create_title")} sub={t("create_sub")} afterAction={error !== ""} />

	<form
		class="flex flex-col gap-5"
		onsubmit={(event) => {
			event.preventDefault();
			handleSubmit();
		}}
	>
		{#if error}
			<div class="pop"><Callout tone="danger" icon="alert">{error}</Callout></div>
		{/if}

		<Composer
			bind:text
			bind:files
			bind:formatted
			bind:generated
			secretNote={contentMode === "secret"}
			{maxFileSize}
			maxFilesPerNote={config.maxFilesPerNote}
		/>

		<Lifetime bind:expiresIn bind:maxReads bind:password bind:passwordOn {passwordError} />

		<button
			type="submit"
			class="btn btn-primary btn-lg rise w-full"
			style:animation-delay="0.3s"
			disabled={!mounted || !canSubmit}
		>
			{t("submit_encrypt")}<Icon name="arrow-right" size={16} />
		</button>

		<div class="rise" style:animation-delay="0.36s">
			<TrustLine />
		</div>
	</form>
{/if}

<script lang="ts">
import type { ContentMode } from "@largerio/secret-shared";
import Icon from "#lib/components/Icon.svelte";
import { t } from "#lib/i18n/index.svelte.js";
import { copyWithFeedback } from "#lib/utils/clipboard.js";

interface Props {
	text: string;
	mode: ContentMode;
	/** The sanitised HTML of a markdown note. */
	html: string;
}

const { text, mode, html }: Props = $props();

let copied = $state(false);
let copyFailed = $state(false);

async function copy(): Promise<void> {
	copyFailed = !(await copyWithFeedback(text, (v) => (copied = v), 1600));
}

function charKind(ch: string): string {
	if (/[0-9]/.test(ch)) return "digit";
	if (/[A-Z]/.test(ch)) return "upper";
	if (/[a-z]/.test(ch)) return "lower";
	return "symbol";
}
</script>

{#if mode === "secret"}
	<section class="card pop flex flex-col gap-3.5 p-[18px]" aria-labelledby="secret-label">
		<span id="secret-label" class="text-xs font-medium text-faint">{t("rv_secret_label")}</span>
		<code class="secret" data-testid="note-secret">
			{#each text as ch, i (i)}<span class={charKind(ch)}>{ch}</span>{/each}
		</code>
		<button type="button" class="btn btn-primary btn-lg" onclick={copy}>
			<Icon name={copied ? "check" : "copy"} size={16} />
			{copied ? t("rv_secret_copied") : t("rv_copy_secret")}
		</button>
	</section>
{:else}
	<section class="card pop" aria-labelledby="note-label">
		<div class="flex items-center justify-between gap-2 border-b border-line py-2 pr-2.5 pl-[18px]">
			<span id="note-label" class="text-xs font-medium text-faint">{t("rv_note_label")}</span>
			<button type="button" class="btn btn-outline btn-sm" onclick={copy}>
				<Icon name={copied ? "check" : "copy"} size={14} />
				{copied ? t("copied") : t("rv_copy_text")}
			</button>
		</div>
		<div class="px-5 py-[18px]">
			{#if mode === "markdown"}
				<div class="prose prose-sm max-w-none" data-testid="note-markdown">{@html html}</div>
			{:else}
				<p class="plain m-0" data-testid="note-text">{text}</p>
			{/if}
		</div>
	</section>
{/if}

{#if copyFailed}
	<p class="m-0 text-center text-[13px] text-danger" role="alert">{t("error_clipboard")}</p>
{/if}

<style>
	.plain {
		font-size: 15px;
		line-height: 1.65;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.secret {
		display: block;
		padding: 18px 16px;
		border-radius: var(--radius-lg);
		background: var(--soft);
		font-family: var(--font-mono);
		font-size: 22px;
		line-height: 1.45;
		letter-spacing: 0.04em;
		text-align: center;
		word-break: break-all;
		user-select: all;
	}

	.upper {
		color: var(--text);
	}

	.lower {
		color: var(--muted);
	}

	.digit {
		color: var(--accent-text);
	}

	.symbol {
		color: var(--accent-2-text);
	}
</style>

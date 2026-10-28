<script lang="ts">
import { MAX_TEXT_SIZE } from "@largerio/secret-shared";
import { onMount, tick } from "svelte";
import Icon, { type IconName } from "#lib/components/Icon.svelte";
import PasswordGenerator from "#lib/components/create/PasswordGenerator.svelte";
import { getLocale, type MessageKey, t, tn } from "#lib/i18n/index.svelte.js";
import { type AttachError, attachFiles } from "#lib/utils/files.js";
import { formatSize } from "#lib/utils/format.js";
import { renderMarkdown } from "#lib/utils/markdown.js";
import { applyFormat, type MarkdownFormat } from "#lib/utils/markdownEdit.js";

interface Props {
	text: string;
	files: File[];
	/** Markdown formatting on or off. */
	formatted: boolean;
	/** The last password the generator inserted: decides whether the note goes out as a password. */
	generated: string | null;
	/** Whether the note, as it stands, will reach the reader as a password to copy. */
	secretNote: boolean;
	maxFileSize: number;
	maxFilesPerNote: number;
}

let {
	text = $bindable(),
	files = $bindable(),
	formatted = $bindable(),
	generated = $bindable(),
	secretNote,
	maxFileSize,
	maxFilesPerNote,
}: Props = $props();

const FORMATS: {
	format: MarkdownFormat;
	icon: IconName | null;
	glyph: string;
	label: MessageKey;
}[] = [
	{ format: "heading", icon: null, glyph: "H", label: "md_btn_heading" },
	{ format: "bold", icon: null, glyph: "B", label: "md_btn_bold" },
	{ format: "italic", icon: null, glyph: "I", label: "md_btn_italic" },
	{ format: "list", icon: "list", glyph: "", label: "md_btn_list" },
	{ format: "link", icon: "link", glyph: "", label: "md_btn_link" },
	{ format: "code", icon: "code", glyph: "", label: "md_btn_code" },
];

let textarea: HTMLTextAreaElement | undefined = $state();
let fileInput: HTMLInputElement | undefined = $state();
let generatorButton: HTMLButtonElement | undefined = $state();
let previewOn = $state(false);
// Null while the markdown renders: nothing stale or empty flashes in between.
let preview = $state<string | null>(null);
let generatorOpen = $state(false);
let dragging = $state(false);
let attachError = $state<AttachError | null>(null);
// dragenter/dragleave fire for every child crossed: count them to know when the pointer really left.
let dragDepth = 0;

const locale = $derived(getLocale());
const showingPreview = $derived(formatted && previewOn);
const limits = $derived(
	tn("files_limit", maxFilesPerNote, { size: formatSize(maxFileSize, locale) }),
);

const attachMessage = $derived.by(() => {
	if (!attachError) return "";
	if (attachError.kind === "tooMany") {
		return tn("error_too_many_files", attachError.ignored, { max: attachError.max });
	}
	const size = formatSize(attachError.limit, locale);
	return attachError.kind === "fileTooLarge"
		? t("error_file_too_large", { size })
		: t("error_total_too_large", { size });
});

// Ready to type on arrival, where a keyboard is at hand. On touch screens the
// keyboard would pop up over the page before anyone asked for it.
onMount(() => {
	if (matchMedia("(pointer: fine)").matches) textarea?.focus();
});

// The textarea is gone while previewing, so the text cannot change under it:
// render once, straight away.
$effect(() => {
	if (!showingPreview) return;
	const source = text;
	let cancelled = false;
	preview = null;
	(source.trim() ? renderMarkdown(source) : Promise.resolve("")).then((html) => {
		if (!cancelled) preview = html;
	});
	return () => {
		cancelled = true;
	};
});

function addFiles(incoming: File[]): void {
	if (incoming.length === 0) return;
	const result = attachFiles(files, incoming, { maxFileSize, maxFilesPerNote });
	files = result.files;
	attachError = result.error;
}

function removeFile(file: File): void {
	files = files.filter((other) => other !== file);
	attachError = null;
}

function restoreSelection(start: number, end: number): void {
	requestAnimationFrame(() => {
		textarea?.focus();
		textarea?.setSelectionRange(start, end);
	});
}

function format(kind: MarkdownFormat): void {
	if (!textarea) return;
	const next = applyFormat(
		{ value: text, start: textarea.selectionStart, end: textarea.selectionEnd },
		kind,
	);
	text = next.value;
	restoreSelection(next.start, next.end);
}

/** Put the generated password where the caret was, then hand the keyboard back. */
function insertPassword(password: string): void {
	const start = textarea?.selectionStart ?? text.length;
	const end = textarea?.selectionEnd ?? text.length;
	const before = text.slice(0, start);
	const glue = before && !/\s$/.test(before) ? " " : "";
	text = `${before}${glue}${password}${text.slice(end)}`;
	generated = password;
	generatorOpen = false;
	previewOn = false;
	const caret = start + glue.length + password.length;
	restoreSelection(caret, caret);
}

// Closed without inserting: the keyboard goes back to the button that opened it.
async function closeGenerator(): Promise<void> {
	generatorOpen = false;
	await tick();
	generatorButton?.focus();
}

const carriesFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") ?? false;

function onDragEnter(event: DragEvent): void {
	if (!carriesFiles(event)) return;
	event.preventDefault();
	dragDepth++;
	dragging = true;
}

function onDragLeave(): void {
	dragDepth = Math.max(0, dragDepth - 1);
	if (dragDepth === 0) dragging = false;
}

function onDragOver(event: DragEvent): void {
	if (carriesFiles(event)) event.preventDefault();
}

// Dropped text keeps its native behaviour in the textarea; only files are taken over.
function onDrop(event: DragEvent): void {
	if (!carriesFiles(event)) return;
	event.preventDefault();
	dragDepth = 0;
	dragging = false;
	addFiles(Array.from(event.dataTransfer?.files ?? []));
}
</script>

<div
	class="card rise relative"
	style:animation-delay="0.18s"
	role="group"
	aria-label={t("note_label")}
	ondragenter={onDragEnter}
	ondragleave={onDragLeave}
	ondragover={onDragOver}
	ondrop={onDrop}
>
	{#if dragging}
		<div class="drop-overlay pop" aria-hidden="true">
			<Icon name="upload" size={22} />
			<span class="text-sm font-medium text-text">{t("drop_hint")}</span>
			<span class="text-xs">{limits}</span>
		</div>
	{/if}

	{#if formatted}
		<div class="md-bar pop">
			<button
				type="button"
				class="btn btn-ghost btn-sm h-8"
				aria-pressed={previewOn}
				onclick={() => (previewOn = !previewOn)}
			>
				<Icon name="eye" size={15} />{t("md_preview")}
			</button>
			{#if !previewOn}
				<div class="flex gap-0.5">
					{#each FORMATS as item (item.format)}
						<button
							type="button"
							class="btn btn-ghost btn-sm btn-icon h-8 w-8 format-{item.format}"
							aria-label={t(item.label)}
							title={t(item.label)}
							onclick={() => format(item.format)}
						>
							{#if item.icon}<Icon name={item.icon} size={15} />{:else}{item.glyph}{/if}
						</button>
					{/each}
				</div>
			{/if}
		</div>
	{/if}

	{#if showingPreview}
		<div class="preview">
			{#if preview}
				<div class="prose prose-sm max-w-none">{@html preview}</div>
			{:else if preview === ""}
				<p class="m-0 text-sm text-faint">{t("md_preview_empty")}</p>
			{/if}
		</div>
	{:else}
		<label for="note-text" class="sr-only">{t("note_label")}</label>
		<textarea
			id="note-text"
			bind:this={textarea}
			bind:value={text}
			placeholder={t("note_placeholder")}
			rows="9"
			maxlength={MAX_TEXT_SIZE}
			spellcheck="false"
			autocapitalize="off"
			autocomplete="off"
		></textarea>
	{/if}

	{#if files.length > 0}
		<ul class="m-0 flex list-none flex-wrap gap-2 px-4 pb-3.5" aria-label={t("attached_files")}>
			{#each files as file (file)}
				<li class="chip pop">
					<Icon name="file" size={14} class="shrink-0 text-accent-text" />
					<span class="min-w-0 flex-1 truncate">{file.name}</span>
					<span class="shrink-0 font-mono text-[11px] text-faint">{formatSize(file.size, locale)}</span>
					<button
						type="button"
						class="btn btn-ghost btn-sm btn-icon h-[26px] w-[26px] shrink-0"
						aria-label={t("remove_file", { name: file.name })}
						onclick={() => removeFile(file)}
					>
						<Icon name="x" size={13} />
					</button>
				</li>
			{/each}
		</ul>
	{/if}

	{#if attachMessage}
		<p class="m-0 px-5 pb-3 text-[13px] text-danger" role="alert">{attachMessage}</p>
	{/if}

	{#if secretNote}
		<p class="pop m-0 inline-flex items-center gap-1.5 px-5 pb-3 text-[12.5px] text-accent-text">
			<Icon name="key" size={13} />{t("secret_note_hint")}
		</p>
	{/if}

	{#if generatorOpen}
		<div id="password-generator">
			<PasswordGenerator oninsert={insertPassword} onclose={closeGenerator} />
		</div>
	{/if}

	<div class="flex items-center justify-between gap-2 px-2 pt-1.5 pb-2">
		<div class="flex flex-wrap gap-0.5">
			<button
				type="button"
				class="btn btn-ghost btn-sm"
				title={t("tool_attach_label")}
				aria-describedby="attach-limits"
				onclick={() => fileInput?.click()}
			>
				<Icon name="paperclip" size={15} />
				<span class="max-[600px]:sr-only">{t("tool_attach")}</span>
			</button>
			<span id="attach-limits" class="sr-only">{limits}</span>
			<input
				id="file-upload"
				bind:this={fileInput}
				type="file"
				multiple
				class="sr-only"
				tabindex="-1"
				aria-hidden="true"
				onchange={(event) => {
					addFiles(Array.from(event.currentTarget.files ?? []));
					event.currentTarget.value = "";
				}}
			/>
			<button
				type="button"
				class="btn btn-ghost btn-sm"
				bind:this={generatorButton}
				aria-expanded={generatorOpen}
				aria-controls={generatorOpen ? "password-generator" : undefined}
				title={t("tool_generate")}
				onclick={() => (generatorOpen = !generatorOpen)}
			>
				<Icon name="key" size={15} />
				<span class="max-[600px]:sr-only">{t("tool_generate")}</span>
			</button>
			<button
				type="button"
				class="btn btn-ghost btn-sm"
				aria-pressed={formatted}
				title={t("tool_format_title")}
				onclick={() => {
					formatted = !formatted;
					previewOn = false;
				}}
			>
				<Icon name="type" size={15} />
				<span class="max-[600px]:sr-only">{t("tool_format")}</span>
			</button>
		</div>
		<span class="pr-2 font-mono text-[11px] whitespace-nowrap text-faint" aria-hidden="true">
			{text.length.toLocaleString(locale)} / {MAX_TEXT_SIZE.toLocaleString(locale)}
		</span>
	</div>
</div>

<style>
	textarea {
		display: block;
		width: 100%;
		min-height: 220px;
		padding: 20px 22px;
		border: 0;
		border-radius: var(--radius-xl) var(--radius-xl) 0 0;
		outline: none;
		resize: vertical;
		background: transparent;
		color: var(--text);
		font: inherit;
		font-size: 15px;
		line-height: 1.65;
	}

	.preview {
		min-height: 220px;
		padding: 20px 22px;
	}

	.md-bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 8px 10px;
		border-bottom: 1px solid var(--line);
	}

	.format-heading,
	.format-bold {
		font-weight: 700;
	}

	.format-italic {
		font-style: italic;
		font-family: Georgia, serif;
		font-size: 15px;
	}

	/* Never wider than the card: at 320 px a long name shrinks, the remove button stays. */
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		max-width: 100%;
		height: 34px;
		padding: 0 4px 0 10px;
		border: 1px solid color-mix(in srgb, var(--accent) 22%, transparent);
		border-radius: var(--radius-md);
		background: var(--accent-soft);
		font-size: 13px;
	}

	.drop-overlay {
		position: absolute;
		inset: 6px;
		z-index: 2;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 6px;
		border: 1.5px dashed var(--accent);
		border-radius: var(--radius-lg);
		background: color-mix(in srgb, var(--surface) 92%, var(--accent));
		color: var(--accent-text);
		pointer-events: none;
	}
</style>

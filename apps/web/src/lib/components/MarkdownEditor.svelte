<script lang="ts">
import DOMPurify from "isomorphic-dompurify";
import { marked } from "marked";
import { t } from "$lib/i18n/index.svelte";

interface Props {
	value: string;
	maxlength?: number;
	placeholder?: string;
}

let { value = $bindable(), maxlength, placeholder }: Props = $props();

let activeTab = $state<"write" | "preview">("write");
let textarea = $state<HTMLTextAreaElement | null>(null);

let renderedHtml = $derived(
	value.trim() ? DOMPurify.sanitize(marked.parse(value, { async: false }) as string) : "",
);

function wrapSelection(before: string, after: string, placeholder: string) {
	if (!textarea) return;

	const start = textarea.selectionStart;
	const end = textarea.selectionEnd;
	const selected = value.slice(start, end);
	const text = selected || placeholder;
	const wrapped = `${before}${text}${after}`;

	value = value.slice(0, start) + wrapped + value.slice(end);

	requestAnimationFrame(() => {
		if (!textarea) return;
		textarea.focus();
		if (selected) {
			textarea.selectionStart = start;
			textarea.selectionEnd = start + wrapped.length;
		} else {
			textarea.selectionStart = start + before.length;
			textarea.selectionEnd = start + before.length + text.length;
		}
	});
}

function insertHeading() {
	if (!textarea) return;

	const start = textarea.selectionStart;
	const end = textarea.selectionEnd;
	const selected = value.slice(start, end);
	const text = selected || "heading";
	const prefix = "## ";

	const lineStart = value.lastIndexOf("\n", start - 1) + 1;
	const insertion = `${prefix}${text}`;

	value = value.slice(0, lineStart) + insertion + value.slice(end);

	requestAnimationFrame(() => {
		if (!textarea) return;
		textarea.focus();
		textarea.selectionStart = lineStart + prefix.length;
		textarea.selectionEnd = lineStart + prefix.length + text.length;
	});
}

function insertBold() {
	wrapSelection("**", "**", "bold text");
}

function insertItalic() {
	wrapSelection("_", "_", "italic text");
}

function insertLink() {
	if (!textarea) return;

	const start = textarea.selectionStart;
	const end = textarea.selectionEnd;
	const selected = value.slice(start, end);
	const text = selected || "link text";
	const wrapped = `[${text}](url)`;

	value = value.slice(0, start) + wrapped + value.slice(end);

	requestAnimationFrame(() => {
		if (!textarea) return;
		textarea.focus();
		const urlStart = start + text.length + 3;
		textarea.selectionStart = urlStart;
		textarea.selectionEnd = urlStart + 3;
	});
}

function insertCode() {
	if (!textarea) return;

	const start = textarea.selectionStart;
	const end = textarea.selectionEnd;
	const selected = value.slice(start, end);

	if (selected.includes("\n")) {
		wrapSelection("```\n", "\n```", "code");
	} else {
		wrapSelection("`", "`", "code");
	}
}

function insertList() {
	if (!textarea) return;

	const start = textarea.selectionStart;
	const end = textarea.selectionEnd;
	const selected = value.slice(start, end);

	if (selected) {
		const lines = selected.split("\n");
		const listed = lines.map((line) => `- ${line}`).join("\n");
		value = value.slice(0, start) + listed + value.slice(end);

		requestAnimationFrame(() => {
			if (!textarea) return;
			textarea.focus();
			textarea.selectionStart = start;
			textarea.selectionEnd = start + listed.length;
		});
	} else {
		const text = "- list item";
		value = value.slice(0, start) + text + value.slice(end);

		requestAnimationFrame(() => {
			if (!textarea) return;
			textarea.focus();
			textarea.selectionStart = start + 2;
			textarea.selectionEnd = start + text.length;
		});
	}
}
</script>

<div class="rounded-lg border border-slate-700">
	<div class="flex items-center justify-between border-b border-slate-700">
		<div class="flex">
			<button
				type="button"
				onclick={() => { activeTab = "write"; }}
				class="px-4 py-2 text-sm font-medium transition-colors {activeTab === 'write'
					? 'border-b-2 border-primary text-primary'
					: 'text-slate-400 hover:text-slate-200'}"
			>
				<i class="fa-solid fa-pen"></i> {t("md_write")}
			</button>
			<button
				type="button"
				onclick={() => { activeTab = "preview"; }}
				class="px-4 py-2 text-sm font-medium transition-colors {activeTab === 'preview'
					? 'border-b-2 border-primary text-primary'
					: 'text-slate-400 hover:text-slate-200'}"
			>
				<i class="fa-solid fa-eye"></i> {t("md_preview")}
			</button>
		</div>

		{#if activeTab === "write"}
			<div class="flex gap-1 pr-2">
				<button type="button" onclick={insertHeading} class="rounded bg-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-600 transition-colors" title="Heading">
					<i class="fa-solid fa-heading"></i>
				</button>
				<button type="button" onclick={insertBold} class="rounded bg-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-600 transition-colors" title="Bold">
					<i class="fa-solid fa-bold"></i>
				</button>
				<button type="button" onclick={insertItalic} class="rounded bg-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-600 transition-colors" title="Italic">
					<i class="fa-solid fa-italic"></i>
				</button>
				<button type="button" onclick={insertLink} class="rounded bg-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-600 transition-colors" title="Link">
					<i class="fa-solid fa-link"></i>
				</button>
				<button type="button" onclick={insertCode} class="rounded bg-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-600 transition-colors" title="Code">
					<i class="fa-solid fa-code"></i>
				</button>
				<button type="button" onclick={insertList} class="rounded bg-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-600 transition-colors" title="List">
					<i class="fa-solid fa-list-ul"></i>
				</button>
			</div>
		{/if}
	</div>

	{#if activeTab === "write"}
		<textarea
			bind:this={textarea}
			bind:value
			{placeholder}
			{maxlength}
			rows="6"
			class="w-full rounded-b-lg border-0 bg-slate-800 px-3 py-2 text-white placeholder-slate-500 focus:outline-none focus:ring-0"
		></textarea>
	{:else}
		<div class="min-h-[10rem] rounded-b-lg bg-slate-800 px-3 py-2">
			{#if renderedHtml}
				<div class="prose prose-invert prose-sm max-w-none">
					{@html renderedHtml}
				</div>
			{:else}
				<p class="py-4 text-center text-sm text-slate-500">{t("md_preview_empty")}</p>
			{/if}
		</div>
	{/if}
</div>

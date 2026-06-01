<script lang="ts">
import Icon from "$lib/components/Icon.svelte";
import { t } from "$lib/i18n/index.svelte";

interface Props {
	value: string;
	maxlength?: number;
	placeholder?: string;
}

let { value = $bindable(), maxlength, placeholder }: Props = $props();

let activeTab = $state<"write" | "preview">("write");
let textarea = $state<HTMLTextAreaElement | null>(null);
let renderedHtml = $state("");

$effect(() => {
	const currentValue = value;
	if (activeTab !== "preview") return;

	const timer = setTimeout(async () => {
		if (!currentValue.trim()) {
			renderedHtml = "";
			return;
		}
		const [{ marked }, DOMPurify] = await Promise.all([
			import("marked"),
			import("isomorphic-dompurify"),
		]);
		renderedHtml = DOMPurify.default.sanitize(
			marked.parse(currentValue, { async: false }) as string,
		);
	}, 200);

	return () => clearTimeout(timer);
});

function wrapSelection(before: string, after: string, placeholderText: string) {
	if (!textarea) return;
	const start = textarea.selectionStart;
	const end = textarea.selectionEnd;
	const selected = value.slice(start, end);
	const text = selected || placeholderText;
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

const toolbarBtnStyle =
	"display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:6px;border:1px solid transparent;background:transparent;color:var(--muted);cursor:pointer;transition:all 0.15s";
</script>

<div
	class="overflow-hidden rounded-xl border"
	style:background="var(--bg-2)"
	style:border-color="var(--line)"
>
	<div
		class="flex items-center justify-between border-b"
		style:border-color="var(--line)"
	>
		<div class="flex">
			{#each [{ id: "write" as const, label: t("md_write") }, { id: "preview" as const, label: t("md_preview") }] as tab (tab.id)}
				<button
					type="button"
					onclick={() => (activeTab = tab.id)}
					class="mono uppercase transition-colors"
					style:padding="10px 14px"
					style:font-size="11px"
					style:letter-spacing="0.08em"
					style:background="transparent"
					style:border="0"
					style:border-bottom={activeTab === tab.id
						? "2px solid var(--accent)"
						: "2px solid transparent"}
					style:color={activeTab === tab.id ? "var(--text)" : "var(--muted)"}
				>
					{tab.label}
				</button>
			{/each}
		</div>
		{#if activeTab === "write"}
			<div class="flex pr-2">
				<button
					type="button"
					onclick={insertHeading}
					style={toolbarBtnStyle}
					title={t("md_btn_heading")}
					aria-label={t("md_btn_heading")}
					><span class="mono" style:font-size="12px" style:font-weight="600">H</span></button
				>
				<button
					type="button"
					onclick={insertBold}
					style={toolbarBtnStyle}
					title={t("md_btn_bold")}
					aria-label={t("md_btn_bold")}
					><span style:font-weight="700" style:font-size="13px">B</span></button
				>
				<button
					type="button"
					onclick={insertItalic}
					style={toolbarBtnStyle}
					title={t("md_btn_italic")}
					aria-label={t("md_btn_italic")}
					><span style:font-style="italic" style:font-size="13px" class="serif">I</span></button
				>
				<button
					type="button"
					onclick={insertLink}
					style={toolbarBtnStyle}
					title={t("md_btn_link")}
					aria-label={t("md_btn_link")}><Icon name="external" size={13} /></button
				>
				<button
					type="button"
					onclick={insertCode}
					style={toolbarBtnStyle}
					title={t("md_btn_code")}
					aria-label={t("md_btn_code")}
					><span class="mono" style:font-size="11px">{"</>"}</span></button
				>
				<button
					type="button"
					onclick={insertList}
					style={toolbarBtnStyle}
					title={t("md_btn_list")}
					aria-label={t("md_btn_list")}
					><span class="mono" style:font-size="13px">•</span></button
				>
			</div>
		{/if}
	</div>

	{#if activeTab === "write"}
		<textarea
			bind:this={textarea}
			bind:value
			{placeholder}
			{maxlength}
			rows="8"
			class="w-full resize-y border-0 outline-none"
			style:background="var(--bg-2)"
			style:color="var(--text)"
			style:padding="14px 16px"
			style:font-family="var(--font-mono)"
			style:font-size="13px"
			style:line-height="1.6"
			style:min-height="180px"
		></textarea>
	{:else}
		<div
			style:background="var(--bg-2)"
			style:color="var(--text)"
			style:padding="14px 16px"
			style:min-height="180px"
		>
			{#if renderedHtml}
				<div class="prose prose-invert prose-sm max-w-none">
					{@html renderedHtml}
				</div>
			{:else}
				<p class="py-4 text-center" style:color="var(--muted-2)" style:font-size="13px">
					{t("md_preview_empty")}
				</p>
			{/if}
		</div>
	{/if}
</div>

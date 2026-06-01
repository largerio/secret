<script lang="ts">
import Icon from "$lib/components/Icon.svelte";
import { t } from "$lib/i18n/index.svelte";
import { formatSize } from "$lib/utils/format";

interface Props {
	files: File[];
	maxFileSize: number;
	maxFilesPerNote: number;
}

let { files = $bindable(), maxFileSize, maxFilesPerNote }: Props = $props();

let isDragging = $state(false);
let fileError = $state("");
let fileInputEl: HTMLInputElement | undefined = $state();

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
	fileError = "";
	const oversized = newFiles.filter((f) => f.size > maxFileSize);
	if (oversized.length > 0) {
		fileError = t("error_file_too_large", { size: formatSize(maxFileSize) });
		return;
	}

	const remaining = maxFilesPerNote - files.length;
	const candidates = [...files, ...newFiles.slice(0, remaining)];
	const totalSize = candidates.reduce((sum, f) => sum + f.size, 0);
	if (totalSize > maxFileSize) {
		fileError = t("error_total_too_large", { size: formatSize(maxFileSize) });
		return;
	}

	files = candidates;
}

function removeFile(index: number) {
	files = files.filter((_, i) => i !== index);
}
</script>

<div class="mb-8">
	<span
		class="mono mb-2 flex items-center gap-1.5 uppercase"
		style:font-size="11px"
		style:letter-spacing="0.08em"
		style:color="var(--muted)"
	>
		<Icon name="paperclip" size={12} />
		<span>{t("files_label")}</span>
	</span>
	<div
		role="button"
		tabindex="0"
		onclick={() => fileInputEl?.click()}
		onkeydown={(e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				fileInputEl?.click();
			}
		}}
		ondragover={(e) => {
			e.preventDefault();
			isDragging = true;
		}}
		ondragleave={() => {
			isDragging = false;
		}}
		ondrop={handleDrop}
		class="w-full cursor-pointer rounded-xl text-left transition-all"
		style:background={isDragging ? "var(--accent-soft)" : "var(--bg-2)"}
		style:border={`1px dashed ${isDragging ? "var(--accent)" : "var(--line-2)"}`}
		style:padding="20px"
		aria-label={t("files_drop")}
	>
		<input
			id="file-upload"
			bind:this={fileInputEl}
			type="file"
			multiple
			onchange={handleFileInput}
			class="hidden"
		/>
		{#if files.length === 0}
			<div class="flex items-center justify-between gap-4">
				<div>
					<div style:color="var(--text)" style:font-size="14px">
						{t("files_drop_1")}
						<span
							style:color="var(--accent)"
							style:font-weight="500"
							style:text-decoration="underline"
							style:text-underline-offset="3px">{t("files_drop_2")}</span
						>
					</div>
					<div class="mono" style:color="var(--muted-2)" style:font-size="11px" style:margin-top="4px">
						{t("files_limit", {
							count: maxFilesPerNote,
							size: formatSize(maxFileSize),
						})}
					</div>
				</div>
				<Icon name="paperclip" size={20} class="opacity-60" />
			</div>
		{:else}
			<div class="flex flex-col gap-2">
				{#each files as f, i (f.name + i)}
					<div
						class="flex items-center gap-2.5 rounded-lg"
						style:background="var(--bg-3)"
						style:padding="8px 10px"
					>
						<Icon name="file" size={14} class="shrink-0" />
						<span class="flex-1 truncate" style:font-size="13px" style:color="var(--text)">
							{f.name}
						</span>
						<span class="mono" style:font-size="11px" style:color="var(--muted-2)">
							{formatSize(f.size)}
						</span>
						<button
							type="button"
							onclick={(e) => {
								e.stopPropagation();
								removeFile(i);
							}}
							class="border-0 bg-transparent p-1"
							style:color="var(--muted)"
							aria-label={t("remove_file", { name: f.name })}
						>
							<Icon name="x" size={14} />
						</button>
					</div>
				{/each}
				<div
					class="mono"
					style:font-size="11px"
					style:color="var(--muted-2)"
					style:padding-left="4px"
					style:margin-top="4px"
				>
					{t("files_add_more")} ({files.length}/{maxFilesPerNote})
				</div>
			</div>
		{/if}
	</div>
	{#if fileError}
		<p class="mt-2" style:font-size="12px" style:color="var(--accent)">{fileError}</p>
	{/if}
</div>

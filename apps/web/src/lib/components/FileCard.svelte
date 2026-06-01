<script lang="ts">
import { fly } from "svelte/transition";
import Icon from "$lib/components/Icon.svelte";
import { t } from "$lib/i18n/index.svelte";
import { getFileCategory } from "$lib/utils/fileType";
import { formatSize } from "$lib/utils/format";

interface Props {
	name: string;
	type: string;
	size: number;
	data: Uint8Array;
	previewUrl: string;
	index: number;
}

const { name, type, size, data, previewUrl, index }: Props = $props();

const category = $derived(getFileCategory(type));

function downloadFile() {
	const blob = new Blob([data] as BlobPart[], { type });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = name;
	a.click();
	URL.revokeObjectURL(url);
}
</script>

<li
	class="overflow-hidden rounded-2xl border"
	style:background="var(--bg-2)"
	style:border-color="var(--line)"
	in:fly={{ y: 20, duration: 300, delay: Math.min(150 * index, 600) }}
>
	{#if previewUrl}
		{#if category === "image"}
			<img
				src={previewUrl}
				alt={name}
				class="max-h-96 w-full object-contain"
				style:background="var(--bg-3)"
			/>
		{:else if category === "video"}
			<video controls class="max-h-96 w-full" style:background="var(--bg-3)" aria-label={name}>
				<source src={previewUrl} {type} />
				<track kind="captions" />
			</video>
		{:else if category === "audio"}
			<audio controls class="w-full" style:padding="16px" aria-label={name}>
				<source src={previewUrl} {type} />
			</audio>
		{:else if category === "pdf"}
			<iframe src={previewUrl} class="h-96 w-full" title={name} sandbox=""></iframe>
		{/if}
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
				{name}
			</p>
			<p class="mono" style:font-size="11px" style:color="var(--muted-2)">
				{type} · {formatSize(size)}
			</p>
		</div>
		<button
			type="button"
			onclick={downloadFile}
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

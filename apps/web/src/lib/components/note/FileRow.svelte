<script lang="ts">
import Icon from "#lib/components/Icon.svelte";
import { getLocale, t } from "#lib/i18n/index.svelte.js";
import { getFileCategory, isPreviewable } from "#lib/utils/fileType.js";
import { formatSize } from "#lib/utils/format.js";

interface Props {
	name: string;
	type: string;
	size: number;
	/** An object URL of the file, for its preview and its download: the page revokes it. */
	url: string;
}

const { name, type, size, url }: Props = $props();

const category = $derived(getFileCategory(type));
const previewUrl = $derived(isPreviewable(type) ? url : "");

function download(): void {
	// The URL stays the page's: revoked on the spot, a download that has not
	// started reading it yet would fail.
	const link = document.createElement("a");
	link.href = url;
	link.download = name;
	link.click();
}
</script>

<li class="overflow-hidden rounded-lg border border-line">
	{#if previewUrl}
		{#if category === "image"}
			<img src={previewUrl} alt={name} class="max-h-96 w-full bg-soft object-contain" />
		{:else if category === "video"}
			<video controls class="max-h-96 w-full bg-soft" aria-label={name}>
				<source src={previewUrl} {type} />
				<track kind="captions" />
			</video>
		{:else if category === "audio"}
			<audio controls class="w-full p-3" aria-label={name}>
				<source src={previewUrl} {type} />
			</audio>
		{/if}
	{/if}
	<div class="flex items-center gap-3 p-2">
		<span class="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-accent-soft text-accent-text">
			<Icon name={category === "image" ? "image" : "file-text"} size={18} />
		</span>
		<span class="flex min-w-0 flex-1 flex-col">
			<span class="truncate text-sm">{name}</span>
			<span class="font-mono text-[11.5px] text-faint">{formatSize(size, getLocale())}</span>
		</span>
		<button type="button" class="btn btn-outline btn-sm" onclick={download}>
			<Icon name="download" size={15} /><span class="max-[600px]:sr-only">{t("rv_download")}</span
			><span class="sr-only">&nbsp;{name}</span>
		</button>
	</div>
</li>

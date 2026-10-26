<script module lang="ts">
export type IconName =
	| "alert"
	| "arrow-left"
	| "arrow-right"
	| "check"
	| "chevron-down"
	| "clock"
	| "code"
	| "copy"
	| "download"
	| "eye"
	| "eye-off"
	| "file"
	| "file-text"
	| "file-x"
	| "flame"
	| "github"
	| "globe"
	| "image"
	| "key"
	| "link"
	| "list"
	| "lock"
	| "mail"
	| "moon"
	| "paperclip"
	| "plus"
	| "qr"
	| "refresh"
	| "shield"
	| "sun"
	| "trash"
	| "type"
	| "unlock"
	| "upload"
	| "x";
</script>

<script lang="ts">
// Stroke icons drawn on a 24-unit grid (Lucide's geometry), so they share one weight.
let {
	name,
	size = 16,
	class: klass = "",
	stroke = 2,
}: { name: IconName; size?: number; class?: string; stroke?: number } = $props();
</script>

<svg
	viewBox="0 0 24 24"
	width={size}
	height={size}
	fill="none"
	stroke="currentColor"
	stroke-width={stroke}
	stroke-linecap="round"
	stroke-linejoin="round"
	class={klass}
	aria-hidden="true"
>
	{#if name === "alert"}
		<circle cx="12" cy="12" r="10" /><path d="M12 8v4M12 16h.01" />
	{:else if name === "arrow-left"}
		<path d="M19 12H5M12 19l-7-7 7-7" />
	{:else if name === "arrow-right"}
		<path d="M5 12h14M12 5l7 7-7 7" />
	{:else if name === "check"}
		<path d="M20 6 9 17l-5-5" />
	{:else if name === "chevron-down"}
		<path d="m6 9 6 6 6-6" />
	{:else if name === "clock"}
		<circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" />
	{:else if name === "code"}
		<path d="m16 18 6-6-6-6M8 6l-6 6 6 6" />
	{:else if name === "copy"}
		<rect width="14" height="14" x="8" y="8" rx="2" /><path
			d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"
		/>
	{:else if name === "download"}
		<path d="M12 15V3M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5" />
	{:else if name === "eye"}
		<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" />
	{:else if name === "eye-off"}
		<path
			d="M10.73 5.08A10.74 10.74 0 0 1 21.94 11.65a1 1 0 0 1 0 .7 10.75 10.75 0 0 1-1.44 2.49M14.08 14.16a3 3 0 0 1-4.24-4.24M17.48 17.5a10.75 10.75 0 0 1-15.42-5.15 1 1 0 0 1 0-.7 10.75 10.75 0 0 1 4.45-5.14M2 2l20 20"
		/>
	{:else if name === "file"}
		<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path
			d="M14 2v4a2 2 0 0 0 2 2h4"
		/>
	{:else if name === "file-text"}
		<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path
			d="M14 2v4a2 2 0 0 0 2 2h4M10 9H8M16 13H8M16 17H8"
		/>
	{:else if name === "file-x"}
		<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path
			d="M14 2v4a2 2 0 0 0 2 2h4M9.5 12.5l5 5M14.5 12.5l-5 5"
		/>
	{:else if name === "flame"}
		<path
			d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z"
		/>
	{:else if name === "github"}
		<path
			d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4M9 18c-4.51 2-5-2-7-2"
		/>
	{:else if name === "globe"}
		<circle cx="12" cy="12" r="10" /><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20M2 12h20" />
	{:else if name === "image"}
		<rect width="18" height="18" x="3" y="3" rx="2" /><circle cx="9" cy="9" r="2" /><path
			d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"
		/>
	{:else if name === "key"}
		<path
			d="M2.59 17.41A2 2 0 0 0 2 18.83V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.17a2 2 0 0 0 1.42-.59l.81-.81a6.5 6.5 0 1 0-4-4z"
		/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor" />
	{:else if name === "link"}
		<path
			d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"
		/>
	{:else if name === "list"}
		<path d="M3 6h.01M3 12h.01M3 18h.01M8 6h13M8 12h13M8 18h13" />
	{:else if name === "lock"}
		<rect width="18" height="11" x="3" y="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
	{:else if name === "mail"}
		<rect width="20" height="16" x="2" y="4" rx="2" /><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
	{:else if name === "moon"}
		<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
	{:else if name === "paperclip"}
		<path
			d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"
		/>
	{:else if name === "plus"}
		<path d="M5 12h14M12 5v14" />
	{:else if name === "qr"}
		<rect width="5" height="5" x="3" y="3" rx="1" /><rect width="5" height="5" x="16" y="3" rx="1" /><rect
			width="5"
			height="5"
			x="3"
			y="16"
			rx="1"
		/><path
			d="M21 16h-3a2 2 0 0 0-2 2v3M21 21v.01M12 7v3a2 2 0 0 1-2 2H7M3 12h.01M12 3h.01M12 16v.01M16 12h1M21 12v.01M12 21v-1"
		/>
	{:else if name === "refresh"}
		<path
			d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M8 16H3v5"
		/>
	{:else if name === "shield"}
		<path
			d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"
		/><path d="m9 12 2 2 4-4" />
	{:else if name === "sun"}
		<circle cx="12" cy="12" r="4" /><path
			d="M12 2v2M12 20v2m-7.07-17.07 1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"
		/>
	{:else if name === "trash"}
		<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
	{:else if name === "type"}
		<path d="M4 7V4h16v3M9 20h6M12 4v16" />
	{:else if name === "unlock"}
		<rect width="18" height="11" x="3" y="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 9.9-1" />
	{:else if name === "upload"}
		<path d="M12 3v12M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5" />
	{:else if name === "x"}
		<path d="M18 6 6 18M6 6l12 12" />
	{/if}
</svg>

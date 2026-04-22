<script lang="ts">
type IconName =
	| "lock"
	| "unlock"
	| "github"
	| "text"
	| "md"
	| "key"
	| "paperclip"
	| "shield"
	| "clock"
	| "eye"
	| "eye-off"
	| "copy"
	| "check"
	| "arrow-right"
	| "file"
	| "x"
	| "qr"
	| "flame"
	| "warn"
	| "sparkle"
	| "dice"
	| "download"
	| "trash"
	| "mail"
	| "external";

let {
	name,
	size = 16,
	class: klass = "",
	stroke = 1.5,
}: { name: IconName; size?: number; class?: string; stroke?: number } = $props();
</script>

{#if name === "lock"}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round" width={size} height={size} class={klass} aria-hidden="true"
		><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg
	>
{:else if name === "unlock"}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round" width={size} height={size} class={klass} aria-hidden="true"
		><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 7.5-2" /></svg
	>
{:else if name === "github"}
	<svg viewBox="0 0 24 24" fill="currentColor" width={size} height={size} class={klass} aria-hidden="true"
		><path d="M12 .5A11.5 11.5 0 0 0 .5 12c0 5.08 3.29 9.39 7.86 10.91.57.1.78-.25.78-.55v-1.93c-3.2.7-3.87-1.54-3.87-1.54-.52-1.33-1.27-1.68-1.27-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.75 1.18 1.75 1.18 1.02 1.75 2.68 1.24 3.33.95.1-.74.4-1.24.72-1.52-2.55-.29-5.24-1.28-5.24-5.68 0-1.25.45-2.28 1.18-3.08-.12-.29-.51-1.46.11-3.05 0 0 .96-.31 3.15 1.18.92-.26 1.9-.38 2.88-.38s1.96.12 2.88.38c2.19-1.49 3.15-1.18 3.15-1.18.62 1.59.23 2.76.11 3.05.73.8 1.18 1.83 1.18 3.08 0 4.41-2.69 5.39-5.25 5.67.41.35.78 1.05.78 2.12v3.14c0 .31.21.66.79.55C20.21 21.39 23.5 17.08 23.5 12A11.5 11.5 0 0 0 12 .5Z"
		/></svg
	>
{:else if name === "text"}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round" width={size} height={size} class={klass} aria-hidden="true"
		><line x1="4" y1="7" x2="20" y2="7" /><line x1="4" y1="12" x2="16" y2="12" /><line x1="4" y1="17" x2="20" y2="17" /></svg
	>
{:else if name === "md"}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round" width={size} height={size} class={klass} aria-hidden="true"
		><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M7 15V9l2 3 2-3v6M15 9v6M13 13l2 2 2-2" /></svg
	>
{:else if name === "key"}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round" width={size} height={size} class={klass} aria-hidden="true"
		><circle cx="8" cy="15" r="4" /><path d="M10.85 12.15 21 2l-3 3 2 2-2 2-2-2-1.5 1.5" /></svg
	>
{:else if name === "paperclip"}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round" width={size} height={size} class={klass} aria-hidden="true"
		><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.19 9.19a2 2 0 1 1-2.83-2.83l8.49-8.48" /></svg
	>
{:else if name === "shield"}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round" width={size} height={size} class={klass} aria-hidden="true"
		><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /></svg
	>
{:else if name === "clock"}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round" width={size} height={size} class={klass} aria-hidden="true"
		><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg
	>
{:else if name === "eye"}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round" width={size} height={size} class={klass} aria-hidden="true"
		><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></svg
	>
{:else if name === "eye-off"}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round" width={size} height={size} class={klass} aria-hidden="true"
		><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" /><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c6.5 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" /><path
			d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3.5 7 10 7a9.74 9.74 0 0 0 5.39-1.61"
		/><line x1="2" y1="2" x2="22" y2="22" /></svg
	>
{:else if name === "copy"}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round" width={size} height={size} class={klass} aria-hidden="true"
		><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg
	>
{:else if name === "check"}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width={size} height={size} class={klass} aria-hidden="true"
		><polyline points="20 6 9 17 4 12" /></svg
	>
{:else if name === "arrow-right"}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round" width={size} height={size} class={klass} aria-hidden="true"
		><line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" /></svg
	>
{:else if name === "file"}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round" width={size} height={size} class={klass} aria-hidden="true"
		><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg
	>
{:else if name === "x"}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round" width={size} height={size} class={klass} aria-hidden="true"
		><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg
	>
{:else if name === "qr"}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round" width={size} height={size} class={klass} aria-hidden="true"
		><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><path d="M14 14h3v3M21 14v7M14 21h3M17 17v4" /></svg
	>
{:else if name === "flame"}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round" width={size} height={size} class={klass} aria-hidden="true"
		><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" /></svg
	>
{:else if name === "warn"}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round" width={size} height={size} class={klass} aria-hidden="true"
		><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line
			x1="12"
			y1="17"
			x2="12.01"
			y2="17"
		/></svg
	>
{:else if name === "sparkle"}
	<svg viewBox="0 0 24 24" fill="currentColor" width={size} height={size} class={klass} aria-hidden="true"
		><path d="M12 2l1.5 5.5L19 9l-5.5 1.5L12 16l-1.5-5.5L5 9l5.5-1.5z" /></svg
	>
{:else if name === "dice"}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round" width={size} height={size} class={klass} aria-hidden="true"
		><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8" cy="8" r="1" fill="currentColor" /><circle cx="16" cy="16" r="1" fill="currentColor" /><circle cx="16" cy="8" r="1" fill="currentColor" /><circle cx="8" cy="16" r="1" fill="currentColor" /></svg
	>
{:else if name === "download"}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round" width={size} height={size} class={klass} aria-hidden="true"
		><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg
	>
{:else if name === "trash"}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round" width={size} height={size} class={klass} aria-hidden="true"
		><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg
	>
{:else if name === "mail"}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round" width={size} height={size} class={klass} aria-hidden="true"
		><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2Z" /><polyline points="22 6 12 13 2 6" /></svg
	>
{:else if name === "external"}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round" width={size} height={size} class={klass} aria-hidden="true"
		><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg
	>
{/if}

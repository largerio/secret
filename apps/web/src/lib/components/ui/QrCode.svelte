<script lang="ts">
import { drawQr, type QrDrawing } from "#lib/utils/qr.js";

interface Props {
	url: string;
	label: string;
}

const { url, label }: Props = $props();

// Two QR codes on one page must not share a gradient id.
const gradientId = $props.id();

let drawing = $state<QrDrawing | null>(null);

$effect(() => {
	let cancelled = false;
	drawQr(url)
		.then((next) => {
			if (!cancelled) drawing = next;
		})
		// The link stays copyable; the code's panel simply stays empty.
		.catch(() => {});
	return () => {
		cancelled = true;
	};
});

// The logo plate sits just inside its cleared square, the lock centred on it.
const plate = $derived(
	drawing ? { start: drawing.logo.start + 0.6, size: drawing.logo.size - 1.2 } : null,
);
const lock = $derived(
	plate ? { size: plate.size * 0.62, start: plate.start + plate.size * 0.19 } : null,
);
</script>

<div class="qr">
	{#if drawing && plate && lock}
		<svg
			viewBox="0 0 {drawing.size} {drawing.size}"
			width="160"
			height="160"
			role="img"
			aria-label={label}
		>
			<defs>
				<linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
					<stop offset="0" style:stop-color="var(--qr-1)" />
					<stop offset="1" style:stop-color="var(--qr-2)" />
				</linearGradient>
			</defs>
			<path d={drawing.dots} style:fill="var(--qr-1)" />
			{#each drawing.finders as finder (`${finder.x}-${finder.y}`)}
				<rect
					x={finder.x + 0.5}
					y={finder.y + 0.5}
					width="6"
					height="6"
					rx="1.9"
					fill="none"
					stroke-width="1"
					style:stroke="url(#{gradientId})"
				/>
				<rect
					x={finder.x + 2}
					y={finder.y + 2}
					width="3"
					height="3"
					rx="0.9"
					style:fill="url(#{gradientId})"
				/>
			{/each}
			<rect
				x={plate.start}
				y={plate.start}
				width={plate.size}
				height={plate.size}
				rx={plate.size / 4}
				style:fill="url(#{gradientId})"
			/>
			<svg
				x={lock.start}
				y={lock.start}
				width={lock.size}
				height={lock.size}
				viewBox="0 0 24 24"
				fill="none"
				stroke="#ffffff"
				stroke-width="2.4"
				stroke-linecap="round"
				stroke-linejoin="round"
			>
				<rect width="18" height="11" x="3" y="11" rx="2" />
				<path d="M7 11V7a5 5 0 0 1 10 0v4" />
			</svg>
		</svg>
	{:else}
		<div class="placeholder" aria-hidden="true"></div>
	{/if}
</div>

<style>
	/* Always dark on white, whatever the theme: some readers fail on inverted codes. */
	.qr {
		padding: 14px;
		border-radius: 12px;
		background: #ffffff;
		box-shadow:
			0 1px 2px rgb(16 16 20 / 0.08),
			0 10px 28px -14px rgb(16 16 20 / 0.35);
		line-height: 0;
	}

	.placeholder {
		width: 160px;
		height: 160px;
	}
</style>

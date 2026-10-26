<!-- The glow behind the top of every page: two slow accent blobs over a dot grid. -->
<div class="aura" aria-hidden="true">
	<div class="dots"></div>
	<div class="blob blob-a"></div>
	<div class="blob blob-b"></div>
</div>

<style>
	.aura {
		position: absolute;
		inset: 0 0 auto;
		z-index: 0;
		height: 640px;
		overflow: hidden;
		pointer-events: none;
	}

	.dots {
		position: absolute;
		inset: 0;
		background-image: radial-gradient(var(--dot) 1px, transparent 1.4px);
		background-size: 22px 22px;
		-webkit-mask-image: radial-gradient(ellipse 55% 75% at 50% 0%, #000 25%, transparent 75%);
		mask-image: radial-gradient(ellipse 55% 75% at 50% 0%, #000 25%, transparent 75%);
	}

	.blob {
		position: absolute;
		border-radius: 50%;
		opacity: var(--aura-opacity);
		filter: blur(90px);
	}

	.blob-a {
		top: -200px;
		left: calc(50% - 440px);
		width: 540px;
		height: 420px;
		background: var(--accent);
		animation: drift-a 18s ease-in-out infinite;
	}

	.blob-b {
		top: -150px;
		left: calc(50% - 30px);
		width: 480px;
		height: 380px;
		background: var(--accent-2);
		animation: drift-b 22s ease-in-out infinite;
	}

	@keyframes drift-a {
		50% {
			transform: translate3d(48px, -26px, 0) scale(1.1);
		}
	}

	@keyframes drift-b {
		50% {
			transform: translate3d(-40px, 20px, 0) scale(0.92);
		}
	}
</style>

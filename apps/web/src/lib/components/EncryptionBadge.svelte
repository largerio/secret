<script lang="ts">
import { t } from "$lib/i18n/index.svelte";

let { compact = false }: { compact?: boolean } = $props();

let tick = $state(0);
$effect(() => {
	const id = setInterval(() => {
		tick = tick + 1;
	}, 2200);
	return () => clearInterval(id);
});
</script>

<span
	class="mono inline-flex items-center gap-2 rounded-full border"
	style:padding={compact ? "4px 10px" : "6px 12px"}
	style:background="var(--bg-2)"
	style:border-color="var(--line)"
	style:color="var(--muted)"
	style:font-size="11px"
>
	<span
		class="inline-block rounded-full"
		style:width="6px"
		style:height="6px"
		style:background="#10b981"
		style:box-shadow={tick % 2 === 0 ? "0 0 0 0 #10b981" : "0 0 0 6px transparent"}
		style:transition="box-shadow 0.8s"
	></span>
	<span style:letter-spacing="0.08em">{t("enc_badge")}</span>
</span>

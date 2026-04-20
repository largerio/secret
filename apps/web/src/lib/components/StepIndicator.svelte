<script lang="ts">
import { getStep } from "$lib/steps.svelte";
import { t } from "$lib/i18n/index.svelte";

const step = $derived(getStep());

const STEPS: { n: 1 | 2 | 3 | 4; key: "step_1" | "step_2" | "step_3" | "step_4" }[] = [
	{ n: 1, key: "step_1" },
	{ n: 2, key: "step_2" },
	{ n: 3, key: "step_3" },
	{ n: 4, key: "step_4" },
];
</script>

<nav
	class="mono pointer-events-none fixed hidden flex-col gap-2 lg:flex"
	style:left="20px"
	style:top="160px"
	style:z-index="5"
	style:font-size="10px"
	style:color="var(--muted-2)"
	style:padding-left="10px"
	style:border-left="1px solid var(--line)"
	aria-label="Flow steps"
>
	{#each STEPS as s (s.n)}
		<span
			class="uppercase"
			style:color={step === s.n ? "var(--accent)" : "var(--muted-2)"}
			style:padding="3px 6px"
			style:border-radius="4px"
			style:letter-spacing="0.1em"
			style:opacity={step === s.n ? "1" : step > s.n ? "0.7" : "0.4"}
		>
			{s.n} · {t(s.key)}
		</span>
	{/each}
</nav>

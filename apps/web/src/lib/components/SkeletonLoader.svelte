<script lang="ts">
interface Props {
	label?: string;
}

let { label = "Loading" }: Props = $props();
</script>

<div class="space-y-4 animate-pulse" role="status" aria-label={label}>
	<div class="h-6 w-48 rounded bg-slate-800"></div>
	<div class="h-4 w-72 rounded bg-slate-800"></div>
	<div class="h-12 w-full rounded-lg bg-slate-800"></div>
	<div class="h-12 w-full rounded-lg bg-slate-800"></div>
</div>

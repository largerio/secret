<script lang="ts">
import Brand from "#lib/components/ui/Brand.svelte";
import { t } from "#lib/i18n/index.svelte.js";
</script>

<!-- While the instance is asked what a link leads to: nothing is claimed yet.
The brand stands where the hero that replaces this screen keeps it, and that
hero's title takes the focus (PageHero's afterAction), so the answer is
announced. -->
<div class="flex flex-col items-center gap-2 pb-2 text-center" aria-busy="true">
	<div class="rise mb-3.5"><Brand /></div>
	<p
		class="rise m-0 inline-flex items-center gap-2.5 text-muted"
		style:animation-delay="0.06s"
		role="status"
	>
		<!-- A loading indicator, which may turn as long as it is shown (WCAG
		2.2.2's essential exception); reduced motion stops it. -->
		<span class="spinner animate-spin" aria-hidden="true"></span>
		{t("checking_link")}
	</p>
</div>

<style>
	.spinner {
		width: 16px;
		height: 16px;
		border: 2px solid var(--accent-soft);
		border-top-color: var(--accent-text);
		border-radius: 50%;
	}
</style>

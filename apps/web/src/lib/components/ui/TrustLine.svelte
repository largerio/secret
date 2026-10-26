<script lang="ts">
import Icon from "#lib/components/Icon.svelte";
import { t } from "#lib/i18n/index.svelte.js";
</script>

<ul
	class="m-0 flex list-none flex-wrap justify-center gap-x-5 gap-y-2 p-0 text-[12.5px] text-muted"
>
	<li class="inline-flex items-center gap-1.5">
		<Icon name="shield" size={14} class="text-accent-text" />{t("trust_e2e")}
	</li>
	<li class="inline-flex items-center gap-1.5">
		<Icon name="code" size={14} class="text-accent-text" />{t("trust_oss")}
	</li>
</ul>

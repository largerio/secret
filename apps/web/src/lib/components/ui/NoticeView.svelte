<script lang="ts">
import Icon, { type IconName } from "#lib/components/Icon.svelte";
import NoticeIcon from "#lib/components/ui/NoticeIcon.svelte";
import PageHero from "#lib/components/ui/PageHero.svelte";
import { t } from "#lib/i18n/index.svelte.js";

interface Props {
	icon: IconName;
	title: string;
	sub: string;
	/** See PageHero: the screen replaces another after an action. */
	afterAction?: boolean;
	/** The way out, a new note by default. */
	action?: { label: string; icon: IconName };
}

const { icon, title, sub, afterAction = false, action }: Props = $props();
</script>

<!-- A screen with nothing to act on but a way out: a missing note, an error. -->
<PageHero {title} {sub} {afterAction}>
	{#snippet lead()}
		<NoticeIcon name={icon} />
	{/snippet}
</PageHero>
<div class="rise flex justify-center" style:animation-delay="0.18s">
	<a href="/" class="btn btn-primary">
		<Icon name={action?.icon ?? "plus"} size={15} />{action?.label ?? t("new_note")}
	</a>
</div>

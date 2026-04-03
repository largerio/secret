import type { ServerConfig } from "@secret/shared";
import { setConfig } from "$lib/config.svelte";
import type { Locale } from "$lib/i18n/index.svelte";
import { setLocale } from "$lib/i18n/index.svelte";

export const load = ({ data }: { data: { config: ServerConfig; locale: Locale } }) => {
	setConfig(data.config);
	setLocale(data.locale);

	return data;
};

import type { ServerConfig } from "@secret/shared";
import { setConfig } from "$lib/config.svelte";
import type { Locale } from "$lib/i18n/index.svelte";
import { setLocale } from "$lib/i18n/index.svelte";
import { initTheme, type ThemeMode } from "$lib/theme.svelte";

export const load = ({
	data,
}: {
	data: { config: ServerConfig; locale: Locale; theme: ThemeMode };
}) => {
	setConfig(data.config);
	setLocale(data.locale);
	initTheme(data.theme);

	return data;
};

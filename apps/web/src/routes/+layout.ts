import type { ServerConfig } from "@largerio/secret-shared";
import { setConfig } from "#lib/config.svelte.js";
import type { Locale } from "#lib/i18n/index.svelte.js";
import { setLocale } from "#lib/i18n/index.svelte.js";
import { initTheme, type ThemeMode } from "#lib/theme.svelte.js";

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

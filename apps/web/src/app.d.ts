import type { Locale } from "#lib/i18n/index.svelte.js";
import type { ThemeMode } from "#lib/theme.svelte.js";

declare global {
	namespace App {
		interface Error {
			message: string;
		}
		interface Locals {
			locale: Locale;
			theme: ThemeMode;
			/** APP_PRIMARY_COLOR as accent variables, set by the root layout's loader. */
			accent?: string;
		}
	}
}

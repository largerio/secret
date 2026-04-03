import type { Locale } from "$lib/i18n/index.svelte";

declare global {
	namespace App {
		interface Locals {
			locale: Locale;
		}
	}
}

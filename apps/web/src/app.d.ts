import type { Locale } from "$lib/i18n/index.svelte";

declare global {
	namespace App {
		interface Error {
			message: string;
		}
		interface Locals {
			locale: Locale;
		}
	}
}

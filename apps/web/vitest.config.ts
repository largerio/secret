import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

// A dedicated project for the SvelteKit frontend: the Svelte plugin compiles
// `$state`/`$derived` rune modules (`*.svelte.ts`) and jsdom provides the
// `document`/`navigator`/cookie surface those modules and the request hooks use.
// `configFile: false` keeps the bare Svelte compiler out of SvelteKit's
// `$app`/`$env` virtual-module machinery (which isn't available under Vitest).
export default defineConfig({
	plugins: [svelte({ configFile: false })],
	resolve: {
		alias: {
			$lib: new URL("./src/lib", import.meta.url).pathname,
		},
		// Resolve the browser entry points of Svelte under jsdom.
		conditions: ["browser"],
	},
	test: {
		name: "web",
		environment: "jsdom",
		include: ["src/**/*.test.ts"],
	},
});

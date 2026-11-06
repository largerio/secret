import adapter from "@sveltejs/adapter-static";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// In dev it is Vite that proxies /api to the backend, so this target must
// follow the API port. Hardcoding it meant the e2e suite could not run the API
// anywhere other than 3001 (ECONNREFUSED on every request that touches the
// backend).
const API_TARGET = process.env["API_URL"] ?? "http://localhost:3001";

export default defineConfig({
	plugins: [
		tailwindcss(),
		// SvelteKit 3 no longer reads svelte.config.js: its configuration lives here.
		sveltekit({
			// A single-page app (the root layout turns SSR off): the build is static
			// files and one HTML document, index.html, which the API fills in and
			// serves for every page (SvelteKit names the assets of this fallback
			// page from the root, as /note/<id>/manage needs). It sends the CSP too,
			// with the hashes of that document's inline scripts. No precompressed
			// copies: zlib's output may change from one version to the next, and
			// the API compresses.
			adapter: adapter({
				pages: "build",
				assets: "build",
				fallback: "index.html",
				precompress: false,
			}),
		}),
	],
	// The worker that encrypts and decrypts notes is a module worker
	// (lib/notes/notes.worker.ts), split like the app.
	worker: { format: "es" },
	build: {
		// Vite inlines any asset under 4 KB as a data: URI, and some Fontsource
		// subsets are that small (JetBrains Mono's cyrillic-ext is 2 KB). The
		// CSP's font-src 'self' blocks a data: font, so fonts always ship as
		// files rather than widening the policy.
		assetsInlineLimit: (filePath) => (/\.woff2?$/.test(filePath) ? false : undefined),
	},
	server: {
		host: true,
		proxy: {
			"/api": {
				target: API_TARGET,
				changeOrigin: true,
			},
		},
	},
});

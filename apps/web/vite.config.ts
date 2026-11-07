import { fileURLToPath } from "node:url";
import adapter from "@sveltejs/adapter-static";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { BUNDLE_SOURCES, sourcesDigest } from "./scripts/sources.ts";

// Under `vite dev`, Vite serves the pages and proxies /api to the API, which
// listens on PORT: `pnpm dev` starts both with the same environment, so the
// proxy reads it as the API does, 3000 when it is unset or blank.
const API_TARGET = `http://localhost:${process.env["PORT"]?.trim() || 3000}`;

// SvelteKit writes the app's version into the bundle (its boot script,
// _app/version.json, the chunks that read it), and reads _app/version.json
// again to tell a new deployment: when the tab comes back into view, when a
// navigation fails, and every version.pollInterval (an hour unless set, never
// when 0). It defaults the version to the build's time: no two builds were
// alike, and nobody could rebuild the bundle an instance serves to check it.
// A digest of what the bundle is built from instead, which changes with any
// of it.
// Not a commit: the image is built without the repository's history. (The
// build script sets NODE_ENV=production: Vite builds for the NODE_ENV it is
// given, and the dev container's, development, gave a dev-mode bundle, with
// the paths of the files it was built from in it.)
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const VERSION = sourcesDigest(REPO_ROOT, BUNDLE_SOURCES).slice(0, 16);

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
			version: { name: VERSION },
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

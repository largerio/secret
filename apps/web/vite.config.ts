import adapter from "@sveltejs/adapter-node";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// In dev it is Vite that proxies /api to the backend, not hooks.server.ts, so
// this target must follow the API port. Hardcoding it meant the e2e suite could
// not run the API anywhere other than 3001 (ECONNREFUSED on every request that
// touches the backend). Same variable as the SSR proxy, so one setting moves both.
const API_TARGET = process.env["API_URL"] ?? "http://localhost:3001";

export default defineConfig({
	plugins: [
		tailwindcss(),
		// SvelteKit 3 no longer reads svelte.config.js: its configuration lives here.
		sveltekit({
			adapter: adapter({
				out: "build",
			}),
			csp: {
				mode: "auto",
				directives: {
					"default-src": ["none"],
					"script-src": ["self", "wasm-unsafe-eval"],
					"style-src": ["self", "unsafe-inline"],
					"img-src": ["self", "data:", "blob:"],
					"connect-src": ["self"],
					"font-src": ["self"],
					"worker-src": ["self", "blob:"],
					"media-src": ["self", "blob:"],
					"frame-src": ["blob:"],
					"object-src": ["none"],
					"frame-ancestors": ["none"],
					"base-uri": ["self"],
					// The app never submits a form (the one <form> calls preventDefault),
					// so 'none' costs nothing and closes the exfiltration path a note
					// author could otherwise build with injected markup.
					"form-action": ["none"],
					// No upgrade-insecure-requests: it rewrites every same-origin asset
					// to https, so an instance served over plain HTTP on a LAN address
					// (a NAS on http://<ip>:3000) never loaded its scripts or styles.
					// Over HTTPS the app already sends HSTS.
				},
			},
		}),
	],
	build: {
		// Vite inlines any asset under 4 KB as a data: URI, and some Fontsource
		// subsets are that small (JetBrains Mono's cyrillic-ext is 2 KB). font-src
		// 'self' blocks a data: font, so fonts always ship as files rather than
		// widening the policy.
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

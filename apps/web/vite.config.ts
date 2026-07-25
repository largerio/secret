import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// In dev it is Vite that proxies /api to the backend, not hooks.server.ts, so
// this target must follow the API port. Hardcoding it meant the e2e suite could
// not run the API anywhere other than 3001 (ECONNREFUSED on every request that
// touches the backend). Same variable as the SSR proxy, so one setting moves both.
const API_TARGET = process.env["API_URL"] ?? "http://localhost:3001";

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
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

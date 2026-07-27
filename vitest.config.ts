import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Two projects: a Node project for the backend packages/API, and a
		// jsdom + Svelte project (apps/web/vitest.config.ts) for the frontend.
		projects: [
			{
				test: {
					name: "node",
					environment: "node",
					// `tests/` holds repo-level checks that belong to no package —
					// deployment files the container actually reads, for instance.
					include: ["packages/**/*.test.ts", "apps/api/**/*.test.ts", "tests/**/*.test.ts"],
					exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/**"],
				},
			},
			"./apps/web/vitest.config.ts",
		],
		coverage: {
			provider: "v8",
			// Only `.ts` sources (this also covers `*.svelte.ts` rune modules);
			// keeps `.svelte`/`.html`/`.css` out of the v8 parser.
			include: ["packages/*/src/**/*.ts", "apps/*/src/**/*.ts"],
			exclude: [
				"**/*.d.ts",
				"**/*.test.ts",
				"**/__tests__/**",
				"**/types.ts",
				// Barrels: `export … from` statements are hoisted, so v8 reports 0%
				// for a file that runs no code of its own. `packages/crypto/src/client.ts`
				// is one despite not being named index.ts.
				"**/index.ts",
				"packages/crypto/src/client.ts",
				// Frontend: gate the logic modules + utils, but exclude route
				// loaders and server-only modules (`$env`/SSR SDK) that need a
				// SvelteKit harness to exercise. (`.svelte` components are already
				// outside the `*.ts` include above.)
				"apps/web/src/routes/**",
				"apps/web/src/lib/server/**",
				"**/storage/interface.ts",
			],
			thresholds: {
				lines: 100,
				functions: 100,
				branches: 100,
				statements: 100,
			},
		},
	},
});

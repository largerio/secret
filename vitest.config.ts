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
				// for a file that runs no code of its own.
				"packages/crypto/src/index.ts",
				"packages/crypto/src/client.ts",
				"packages/sdk-js/src/index.ts",
				"packages/shared/src/index.ts",
				// Entry points that start a server on import. The image smoke test
				// runs both.
				"apps/api/src/index.ts",
				"apps/web/src/server/index.ts",
				// The backup command's entry point: one line handing argv to
				// runBackupCommand (db/backup.ts), which is tested.
				"apps/api/src/backup.ts",
				// Frontend: gate the logic modules + utils, but exclude route
				// loaders and server-only modules (`$app/env`/SSR SDK) that need a
				// SvelteKit harness to exercise. (`.svelte` components are already
				// outside the `*.ts` include above.)
				"apps/web/src/routes/**",
				"apps/web/src/lib/server/**",
				// The worker's entry point, which wires `lib/notes/worker.ts` to the
				// worker's messages; the e2e suite runs it.
				"apps/web/src/lib/notes/notes.worker.ts",
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

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
					include: ["packages/**/*.test.ts", "apps/api/**/*.test.ts"],
					exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/**"],
				},
			},
			"./apps/web/vitest.config.ts",
		],
		coverage: {
			provider: "v8",
			include: ["packages/*/src/**", "apps/*/src/**"],
			exclude: [
				"**/*.d.ts",
				"**/index.ts",
				"**/*.test.ts",
				"**/__tests__/**",
				"**/types.ts",
				"apps/web/src/**",
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

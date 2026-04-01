import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/**"],
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
				"packages/crypto/src/client.ts",
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

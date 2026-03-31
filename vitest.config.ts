import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		coverage: {
			provider: "v8",
			include: ["packages/*/src/**", "apps/*/src/**"],
			exclude: ["**/*.d.ts", "**/index.ts", "**/*.test.ts", "**/__tests__/**", "**/types.ts"],
			thresholds: {
				lines: 100,
				functions: 100,
				branches: 100,
				statements: 100,
			},
		},
	},
});

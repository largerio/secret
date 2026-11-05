import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/bin.ts"],
	format: ["esm"],
	platform: "node",
	target: "node22",
	banner: { js: "#!/usr/bin/env node" },
	// The SDK is a dependency of the published package, installed with it.
	external: ["@largerio/secret-sdk"],
	dts: false,
	sourcemap: false,
	clean: true,
});

import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts"],
	format: ["esm"],
	dts: true,
	sourcemap: true,
	clean: true,
	treeshake: true,
	target: "es2022",
	// Inline the internal workspace packages (crypto + shared) so consumers
	// install a single self-contained package. zod (only used by shared's
	// server-side validation) is tree-shaken out — the SDK imports only types
	// and two constants from shared.
	noExternal: [/^@largerio\/secret-(crypto|shared)(\/|$)/],
	// Heavy runtime deps stay external and are installed via npm.
	external: ["libsodium-wrappers-sumo", "@msgpack/msgpack"],
});

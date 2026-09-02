import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/cli.ts"],
	format: ["esm"],
	// A binary has no consumers importing it: no declarations to emit.
	dts: false,
	sourcemap: false,
	clean: true,
	treeshake: true,
	// The SDK sets the Node floor for this package; keep the emitted syntax at
	// the same baseline.
	target: "es2022",
	// npm marks bin files executable at install time, but the shebang has to be
	// in the file. The source has none: esbuild would keep it and the banner
	// would duplicate it.
	banner: { js: "#!/usr/bin/env node" },
	// The SDK is a real dependency of the published package, installed from
	// npm — never inlined: bundling it would duplicate libsodium and the crypto
	// layer, and pin consumers to whatever SDK build the CLI was compiled with.
	external: ["@largerio/secret-sdk"],
});

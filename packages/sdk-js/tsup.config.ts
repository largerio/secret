import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts"],
	format: ["esm"],
	// `dts: true` alone only bundles the *runtime*: the generated .d.ts kept
	// `import … from "@largerio/secret-shared"`, a package marked private and
	// never published, so every TypeScript consumer got TS2307 — including on
	// the example in the README. `resolve` inlines those declarations too.
	dts: { resolve: [/^@largerio\/secret-(crypto|shared)(\/|$)/] },
	// Not published (see "files"): a 1.2 MB map for a 580 KB bundle tripled the
	// tarball for something no consumer of a published package consumes.
	sourcemap: false,
	clean: true,
	treeshake: true,
	// Published baseline for the bundle (broad Node/browser support). The repo
	// otherwise targets ES2025; keep bundled-in code within es2022 syntax.
	target: "es2022",
	// Inline the internal workspace packages (crypto + shared) so consumers
	// install a single self-contained package. zod (only used by shared's
	// server-side validation) is tree-shaken out — the SDK imports only types
	// and two constants from shared.
	noExternal: [/^@largerio\/secret-(crypto|shared)(\/|$)/],
	// Heavy runtime deps stay external and are installed via npm.
	external: ["libsodium-wrappers-sumo", "@msgpack/msgpack"],
});

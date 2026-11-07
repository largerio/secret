import { fileURLToPath } from "node:url";
import { BUNDLE_MANIFEST } from "@largerio/secret-shared/bundle";
import { writeBundleManifest } from "./manifest.ts";

// Run by the build after `vite build`: checks the shell in build/, then
// writes its manifest there (manifest.ts, which is tested).
const build = fileURLToPath(new URL("../build", import.meta.url));
const manifest = writeBundleManifest(build);
console.log(`${BUNDLE_MANIFEST}: ${manifest.files.length} files, ${manifest.digest}`);

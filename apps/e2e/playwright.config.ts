import { randomBytes } from "node:crypto";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

// Throwaway key for the test API instance, generated per run (32 bytes, base64).
// Each run starts from an empty temp database, so it never needs to be stable —
// and not committing a literal keeps secret scanners happy.
const TEST_SERVER_ENCRYPTION_KEY = randomBytes(32).toString("base64");

// The port of the instance the suite starts from the sources, when
// E2E_BASE_URL names none: not E2E_PORT, the one .github/scripts/e2e-image.sh
// runs the image on. A dedicated port, distinct from the dev servers' (Vite's
// 5173, the API's 3000): with reuseExistingServer, a `pnpm dev` running in
// another terminal would otherwise be reused, writing the suite's notes into
// ./data/secret.db and running the PoW at production difficulty (serverEnv
// below would never be applied).
const PORT = Number(process.env["E2E_SOURCES_PORT"] ?? 4173);

// Set, the suite runs against that instance and starts no server: CI points it
// at the image it builds, on S3 storage (.github/scripts/e2e-image.sh, which
// applies the settings below to the image).
const BASE_URL = process.env["E2E_BASE_URL"];

// Absolute paths so they resolve the same regardless of each pnpm script's cwd.
const TMP_DIR = path.resolve(import.meta.dirname, ".e2e-tmp");

// Smaller than the SDK's 4 MiB default: a chunked upload only works if the web
// app hands the instance's chunk size to the SDK.
const CHUNK_SIZE = String(1024 * 1024);

// Keep Proof-of-Work trivial so the in-browser Cap widget solves instantly.
const serverEnv = {
	SERVER_ENCRYPTION_KEY: TEST_SERVER_ENCRYPTION_KEY,
	CAP_DIFFICULTY: "1",
	CAP_CHALLENGE_COUNT: "1",
	// The whole suite hits the API from one address, so the per-IP budget is
	// shared by all its tests (38) running back to back. Without this the later
	// ones get 429s that surface as "Service unavailable".
	RATE_LIMIT_MULTIPLIER: "50",
	CHUNK_SIZE,
	DATABASE_PATH: path.join(TMP_DIR, "secret.db"),
	FILES_PATH: path.join(TMP_DIR, "files"),
	PORT: String(PORT),
};

export default defineConfig({
	testDir: "./tests",
	fullyParallel: false,
	forbidOnly: !!process.env["CI"],
	retries: process.env["CI"] ? 1 : 0,
	workers: 1,
	reporter: process.env["CI"] ? [["list"], ["html", { open: "never" }]] : "list",
	use: {
		baseURL: BASE_URL ?? `http://localhost:${PORT}`,
		// Pinned: the assertions match English UI copy, and the app picks its
		// locale from Accept-Language. A runner (or a local Chromium) in another
		// language fails every test with an opaque 30s timeout.
		locale: "en-US",
		extraHTTPHeaders: { "accept-language": "en-US,en;q=0.9" },
		// The app's infinite animations (the card border, the background glow)
		// stop under reduced motion: the a11y scan can settle the page, and the
		// reduced-motion path gets exercised on every run.
		reducedMotion: "reduce",
		trace: "on-first-retry",
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
	webServer: BASE_URL
		? []
		: [
				{
					// What an instance runs, from the sources: the web app's static
					// build, served with the API by the one server, which finds it in
					// apps/web/build. Wipe the temp dir first: it is keyed to a per-run
					// random server key, so leftovers from a previous run are
					// undecryptable dead weight.
					command: [
						`rm -rf "${TMP_DIR}"`,
						`mkdir -p "${path.join(TMP_DIR, "files")}"`,
						"pnpm --filter @largerio/web build",
						"pnpm --filter @largerio/api dev",
					].join(" && "),
					port: PORT,
					env: serverEnv,
					reuseExistingServer: !process.env["CI"],
					// The build comes first.
					timeout: 240_000,
				},
			],
});

import { randomBytes } from "node:crypto";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

// Throwaway key for the test API instance, generated per run (32 bytes, base64).
// Each run starts from an empty temp database, so it never needs to be stable —
// and not committing a literal keeps secret scanners happy.
const TEST_SERVER_ENCRYPTION_KEY = randomBytes(32).toString("base64");

// Dedicated ports, distinct from the 5173/3001 dev defaults: with
// reuseExistingServer, a `pnpm dev` running in another terminal would otherwise
// be reused, writing ~18 test notes into ./data/secret.db and running the PoW
// at production difficulty (apiEnv below would never be applied).
const WEB_PORT = Number(process.env["E2E_WEB_PORT"] ?? 4173);
const API_PORT = Number(process.env["E2E_API_PORT"] ?? 4001);

// Absolute paths so they resolve the same regardless of each pnpm script's cwd.
const TMP_DIR = path.resolve(import.meta.dirname, ".e2e-tmp");

// Keep Proof-of-Work trivial so the in-browser Cap widget solves instantly.
const apiEnv = {
	SERVER_ENCRYPTION_KEY: TEST_SERVER_ENCRYPTION_KEY,
	CAP_DIFFICULTY: "1",
	CAP_CHALLENGE_COUNT: "1",
	// The whole suite hits the API from one address, so the per-IP budget is
	// shared by all 26 tests running back to back. Without this the later ones
	// get 429s that surface as "Service unavailable".
	RATE_LIMIT_MULTIPLIER: "50",
	DATABASE_PATH: path.join(TMP_DIR, "secret.db"),
	FILES_PATH: path.join(TMP_DIR, "files"),
	PORT: String(API_PORT),
};

export default defineConfig({
	testDir: "./tests",
	fullyParallel: false,
	forbidOnly: !!process.env["CI"],
	retries: process.env["CI"] ? 1 : 0,
	workers: 1,
	reporter: process.env["CI"] ? [["list"], ["html", { open: "never" }]] : "list",
	use: {
		baseURL: `http://localhost:${WEB_PORT}`,
		// Pinned: the assertions match English UI copy, and the app picks its
		// locale from Accept-Language. A runner (or a local Chromium) in another
		// language fails every test with an opaque 30s timeout.
		locale: "en-US",
		extraHTTPHeaders: { "accept-language": "en-US,en;q=0.9" },
		trace: "on-first-retry",
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
	webServer: [
		{
			// Wipe the temp dir first: it is keyed to a per-run random server key,
			// so leftovers from a previous run are undecryptable dead weight.
			command: `rm -rf "${TMP_DIR}" && mkdir -p "${path.join(TMP_DIR, "files")}" && pnpm --filter @largerio/api dev`,
			port: API_PORT,
			env: apiEnv,
			reuseExistingServer: !process.env["CI"],
			timeout: 120_000,
		},
		{
			command: `pnpm --filter @largerio/web dev --port ${String(WEB_PORT)}`,
			port: WEB_PORT,
			// The web dev server proxies to the API; without this it falls back to
			// the hardcoded http://localhost:3001 default.
			env: { API_URL: `http://localhost:${String(API_PORT)}` },
			reuseExistingServer: !process.env["CI"],
			timeout: 120_000,
		},
	],
});

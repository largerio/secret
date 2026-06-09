import { randomBytes } from "node:crypto";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

// Throwaway key for the test API instance, generated per run (32 bytes, base64).
// Each run starts from an empty temp database, so it never needs to be stable —
// and not committing a literal keeps secret scanners happy.
const TEST_SERVER_ENCRYPTION_KEY = randomBytes(32).toString("base64");

const WEB_PORT = 5173;
const API_PORT = 3001;

// Absolute paths so they resolve the same regardless of each pnpm script's cwd.
const TMP_DIR = path.resolve(import.meta.dirname, ".e2e-tmp");

// Keep Proof-of-Work trivial so the in-browser Cap widget solves instantly.
const apiEnv = {
	SERVER_ENCRYPTION_KEY: TEST_SERVER_ENCRYPTION_KEY,
	CAP_DIFFICULTY: "1",
	CAP_CHALLENGE_COUNT: "1",
	DATABASE_PATH: path.join(TMP_DIR, "secret.db"),
	FILES_PATH: path.join(TMP_DIR, "files"),
	PORT: String(API_PORT),
};

export default defineConfig({
	testDir: "./tests",
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	workers: 1,
	reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
	use: {
		baseURL: `http://localhost:${WEB_PORT}`,
		trace: "on-first-retry",
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
	webServer: [
		{
			command: `mkdir -p "${path.join(TMP_DIR, "files")}" && pnpm --filter @largerio/api dev`,
			port: API_PORT,
			env: apiEnv,
			reuseExistingServer: !process.env.CI,
			timeout: 120_000,
		},
		{
			command: "pnpm --filter @largerio/web dev",
			port: WEB_PORT,
			reuseExistingServer: !process.env.CI,
			timeout: 120_000,
		},
	],
});

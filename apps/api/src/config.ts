import { readFileSync } from "node:fs";
import {
	CLEANUP_INTERVAL_MS,
	DEFAULT_CAP_CHALLENGE_COUNT,
	DEFAULT_CAP_DIFFICULTY,
	DEFAULT_CHUNK_SIZE,
	DEFAULT_MAX_CHUNKED_SIZE,
	MAX_EXPIRY_SECONDS,
	MAX_FILE_SIZE,
	MAX_FILES_PER_NOTE,
	MIN_EXPIRY_SECONDS,
	withoutTrailingSlashes,
} from "@largerio/secret-shared";
import { buildTrustedBlockList } from "./middleware/rateLimit.js";
import type { StorageConfig, StorageType } from "./storage/index.js";

/**
 * Read a numeric setting, treating an empty value as absent.
 *
 * `FOO=` in a .env file (or an unset `${FOO}` in a compose file) arrives as an
 * empty string, and `Number("")` is 0 — which failed the positive-integer
 * checks below and aborted startup with a message that never mentioned the
 * real problem. A blank value should mean "use the default".
 */
function readEnvNumber(value: string | undefined, fallback: number): number {
	if (value === undefined || value.trim() === "") return fallback;
	return Number(value);
}

/**
 * On: "1" or "true". Off: "0" or "false". Blank keeps the default. Anything
 * else is refused, so a typo such as `yes` cannot silently mean off.
 */
function readEnvBoolean(name: string, value: string | undefined, fallback = false): boolean {
	const normalized = (value ?? "").trim().toLowerCase();
	if (normalized === "") return fallback;
	if (normalized === "1" || normalized === "true") return true;
	if (normalized === "0" || normalized === "false") return false;
	throw new ConfigError(`${name} must be true or false (or 1 or 0)`);
}

/**
 * A secret, from `NAME` or from the file `NAME_FILE` names, the way Docker and
 * Kubernetes hand out secrets. Blank counts as unset, since compose passes
 * `NAME=` for every variable it lists; both at once is refused, not guessed at.
 */
function readSecret(env: NodeJS.ProcessEnv, name: string): string | undefined {
	const value = env[name];
	const hasValue = value !== undefined && value.trim() !== "";
	const path = env[`${name}_FILE`]?.trim();
	if (!path) {
		return hasValue ? value : undefined;
	}
	if (hasValue) {
		throw new ConfigError(`Set ${name} or ${name}_FILE, not both.`);
	}
	return readSecretFile(`${name}_FILE`, path);
}

/**
 * The file's content without its final line breaks. Errors name the variable
 * and the path, never what the file holds.
 */
function readSecretFile(name: string, path: string): string {
	let content: string;
	try {
		content = readFileSync(path, "utf8");
	} catch (err) {
		throw new ConfigError(
			`${name} is set, but ${path} cannot be read (${String((err as NodeJS.ErrnoException).code)}).`,
			"The file must exist and be readable by the user the server runs as (uid 1001 in the Docker image).",
		);
	}

	// A loop rather than /[\r\n]+$/, which backtracks quadratically on a long
	// run of line breaks followed by anything else.
	let end = content.length;
	while (end > 0 && (content[end - 1] === "\n" || content[end - 1] === "\r")) end--;
	const secret = content.slice(0, end);

	if (secret.trim() === "") {
		throw new ConfigError(`${name} is set, but ${path} is empty.`);
	}
	return secret;
}

/** The longest delay setInterval honors; a longer one is clamped to 1 ms. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** AES-256 server layer key size. */
const SERVER_KEY_BYTES = 32;

/** Roughly the length of `openssl rand -base64 32`; rejects toy keys. */
const MIN_API_KEY_LENGTH = 32;

/** The metrics token is reachable from the internet too: same bar as an API key. */
const MIN_METRICS_TOKEN_LENGTH = 32;

/**
 * Seconds a shutdown waits for in-flight requests: under the 10 s Docker leaves
 * between SIGTERM and SIGKILL. The web server in the image drains as long.
 */
const DEFAULT_SHUTDOWN_TIMEOUT = 8;
const MAX_SHUTDOWN_TIMEOUT = 3600;

/**
 * Raised when an environment value fails validation. The entry point catches
 * this, prints the message (plus optional hint), and exits with status 1 —
 * keeping `parseConfig` pure and unit-testable (it never calls `process.exit`).
 */
export class ConfigError extends Error {
	readonly hint?: string;

	constructor(message: string, hint?: string) {
		super(message);
		this.name = "ConfigError";
		if (hint !== undefined) {
			this.hint = hint;
		}
	}
}

export interface AppConfig {
	readonly port: number;
	readonly host: string;
	readonly databasePath: string;
	readonly filesPath: string;
	/** APP_URL, normalized: always http(s), never a trailing slash. */
	readonly appUrl: string;
	/** Raw SERVER_ENCRYPTION_KEY; decoded into a Buffer by the entry point. */
	readonly serverKey: string;
	readonly cleanupIntervalMs: number;
	readonly capDifficulty: number;
	readonly capChallengeCount: number;
	readonly apiKeys: ReadonlyArray<string>;
	readonly storageBackend: StorageType;
	readonly storage: StorageConfig;
	/** Daily sweep of stored objects no note points to (see reconcile.ts). */
	readonly storageReconcile: boolean;
	readonly maxFileSize: number;
	readonly maxFilesPerNote: number;
	/** Total bytes of stored encrypted payloads; 0 disables the quota. */
	readonly storageQuotaBytes: number;
	/** Operator-enforced retention ceiling; cannot exceed MAX_EXPIRY_SECONDS. */
	readonly maxExpirySeconds: number;
	readonly chunkSize: number;
	readonly maxChunkedFileSize: number;
	readonly trustedProxies: ReadonlyArray<string>;
	/** Scales every per-IP rate limit; >1 for deployments behind a shared address. */
	readonly rateLimitMultiplier: number;
	/** Opt-in escape hatch for the server-key fingerprint guard (see keyGuard.ts). */
	readonly allowServerKeyChange: boolean;
	readonly debug: boolean;
	/** Bearer token for `GET /api/metrics`; empty leaves the endpoint off (404). */
	readonly metricsToken: string;
	/** How long a shutdown waits for in-flight requests before it cuts them. */
	readonly shutdownTimeoutMs: number;
}

/**
 * Warn when per-IP rate limiting cannot actually tell clients apart.
 *
 * Behind any proxy the peer address is the proxy's. Without TRUSTED_PROXIES the
 * API has no reason to believe the forwarded address, and correctly falls back
 * to the peer — which means *every* user shares a single bucket. The limits
 * still apply, they just apply to the whole instance at once, and nothing about
 * that is visible from the outside. The Docker image's entrypoint trusts its
 * own web app (127.0.0.1/32) unless told otherwise, so this mostly concerns
 * the API run outside the image.
 *
 * Returns null when the configuration can distinguish clients (or when the API
 * is exposed directly, where the peer address is the real one).
 *
 * @returns A message to log at startup, or null.
 */
export function describeRateLimitScope(config: {
	trustedProxies: ReadonlyArray<string>;
}): string | null {
	if (config.trustedProxies.length > 0) return null;

	return [
		"WARNING: TRUSTED_PROXIES is empty, so per-IP rate limits are shared by all",
		"users behind any proxy, including the bundled web app. If a proxy sits in",
		"front of this API, list its address, e.g. for the web app on this host:",
		"  TRUSTED_PROXIES=127.0.0.1/32",
		"and, on the web app, ADDRESS_HEADER=X-Forwarded-For plus XFF_DEPTH=<number",
		"of proxies in front of it>. See",
		"docs/self-hosting.md#making-rate-limiting-work-behind-a-proxy.",
		"Ignore this if the API is exposed directly, with no proxy in front.",
	].join("\n");
}

/**
 * Parse and validate configuration from a process environment. Throws
 * {@link ConfigError} on any invalid value so the caller can decide how to
 * surface it (the entry point logs + exits; tests assert on the message).
 */
export function parseConfig(env: NodeJS.ProcessEnv): AppConfig {
	const port = readEnvNumber(env["PORT"], Number("3001"));
	const host = env["HOST"] ?? "0.0.0.0";
	const databasePath = env["DATABASE_PATH"] ?? "./data/secret.db";
	const filesPath = env["FILES_PATH"] ?? "./data/files";
	const serverKey = readSecret(env, "SERVER_ENCRYPTION_KEY");
	const rawAppUrl = env["APP_URL"]?.trim() || `http://localhost:${String(port)}`;
	const cleanupIntervalMs = readEnvNumber(
		env["CLEANUP_INTERVAL_MS"],
		Number(String(CLEANUP_INTERVAL_MS)),
	);
	const capDifficulty = readEnvNumber(
		env["CAP_DIFFICULTY"],
		Number(String(DEFAULT_CAP_DIFFICULTY)),
	);
	const capChallengeCount = readEnvNumber(env["CAP_CHALLENGE_COUNT"], DEFAULT_CAP_CHALLENGE_COUNT);

	// API_KEY, API_KEY_1, API_KEY_2…, each from its variable or its _FILE.
	const apiKeyNames = new Set(
		Object.keys(env).flatMap((key) => /^(API_KEY(?:_\d+)?)(?:_FILE)?$/.exec(key)?.[1] ?? []),
	);
	const apiKeys = [...apiKeyNames]
		.map((name) => readSecret(env, name)?.trim())
		.filter((v): v is string => Boolean(v));

	const storageBackend = (env["STORAGE_BACKEND"] ?? "local") as StorageType;
	const s3Bucket = env["S3_BUCKET"] ?? "";
	const s3Region = env["S3_REGION"] ?? "us-east-1";
	const s3Endpoint = env["S3_ENDPOINT"];
	const s3AccessKeyId = readSecret(env, "S3_ACCESS_KEY_ID") ?? "";
	const s3SecretAccessKey = readSecret(env, "S3_SECRET_ACCESS_KEY") ?? "";
	const s3ForcePathStyle = readEnvBoolean("S3_FORCE_PATH_STYLE", env["S3_FORCE_PATH_STYLE"]);
	const storageReconcile = readEnvBoolean("STORAGE_RECONCILE", env["STORAGE_RECONCILE"], true);
	const allowServerKeyChange = readEnvBoolean(
		"ALLOW_SERVER_KEY_CHANGE",
		env["ALLOW_SERVER_KEY_CHANGE"],
	);
	const debug = readEnvBoolean("DEBUG", env["DEBUG"]);
	const metricsToken = env["METRICS_TOKEN"]?.trim() ?? "";
	const shutdownTimeout = readEnvNumber(env["SHUTDOWN_TIMEOUT"], DEFAULT_SHUTDOWN_TIMEOUT);

	const maxFileSize = readEnvNumber(env["MAX_FILE_SIZE"], Number(String(MAX_FILE_SIZE)));
	const maxFilesPerNote = readEnvNumber(
		env["MAX_FILES_PER_NOTE"],
		Number(String(MAX_FILES_PER_NOTE)),
	);
	const storageQuotaBytes = readEnvNumber(env["STORAGE_QUOTA_BYTES"], Number("0"));
	const maxExpirySeconds = readEnvNumber(env["MAX_EXPIRY"], Number(String(MAX_EXPIRY_SECONDS)));
	const chunkSize = readEnvNumber(env["CHUNK_SIZE"], Number(String(DEFAULT_CHUNK_SIZE)));
	const maxChunkedFileSize = readEnvNumber(env["MAX_CHUNKED_FILE_SIZE"], DEFAULT_MAX_CHUNKED_SIZE);
	const rateLimitMultiplier = readEnvNumber(env["RATE_LIMIT_MULTIPLIER"], Number("1"));
	const trustedProxies = (env["TRUSTED_PROXIES"] ?? "")
		.split(",")
		.map((v) => v.trim())
		.filter((v) => v.length > 0);

	if (!serverKey) {
		throw new ConfigError(
			"SERVER_ENCRYPTION_KEY is required.",
			"Generate one with: openssl rand -base64 32",
		);
	}

	// Decoded here rather than only at parseServerKey() so an invalid key exits
	// with the same actionable message as a missing one, instead of an uncaught
	// stack trace from the crypto layer.
	if (Buffer.from(serverKey, "base64").length !== SERVER_KEY_BYTES) {
		throw new ConfigError(
			"SERVER_ENCRYPTION_KEY must be 32 bytes (256 bits) encoded in base64.",
			"Generate one with: openssl rand -base64 32",
		);
	}

	// A weak API key is reachable from the internet (the web app forwards the
	// Authorization header to the API), so refuse the ones that are brute-forceable.
	const weakKey = apiKeys.find((key) => key.length < MIN_API_KEY_LENGTH);
	if (weakKey !== undefined) {
		throw new ConfigError(
			`API keys must be at least ${String(MIN_API_KEY_LENGTH)} characters long.`,
			"Generate one with: openssl rand -base64 32",
		);
	}

	if (metricsToken !== "" && metricsToken.length < MIN_METRICS_TOKEN_LENGTH) {
		throw new ConfigError(
			`METRICS_TOKEN must be at least ${String(MIN_METRICS_TOKEN_LENGTH)} characters long.`,
			"Generate one with: openssl rand -base64 32",
		);
	}

	if (
		!Number.isInteger(shutdownTimeout) ||
		shutdownTimeout < 1 ||
		shutdownTimeout > MAX_SHUTDOWN_TIMEOUT
	) {
		throw new ConfigError(
			`SHUTDOWN_TIMEOUT must be an integer between 1 and ${String(MAX_SHUTDOWN_TIMEOUT)} seconds`,
		);
	}

	if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
		throw new ConfigError("PORT must be an integer between 1 and 65535");
	}

	const appUrl = URL.parse(rawAppUrl);
	if (!appUrl || (appUrl.protocol !== "http:" && appUrl.protocol !== "https:")) {
		throw new ConfigError("APP_URL must be an http:// or https:// URL");
	}

	if (Number.isNaN(cleanupIntervalMs) || cleanupIntervalMs <= 0) {
		throw new ConfigError("CLEANUP_INTERVAL_MS must be a positive number");
	}

	if (cleanupIntervalMs > MAX_TIMER_DELAY_MS) {
		throw new ConfigError(
			`CLEANUP_INTERVAL_MS cannot exceed ${String(MAX_TIMER_DELAY_MS)} (about 24 days)`,
		);
	}

	if (!Number.isInteger(capDifficulty) || capDifficulty < 1 || capDifficulty > 6) {
		throw new ConfigError("CAP_DIFFICULTY must be an integer between 1 and 6");
	}

	if (!Number.isInteger(capChallengeCount) || capChallengeCount < 1) {
		throw new ConfigError("CAP_CHALLENGE_COUNT must be a positive integer");
	}

	if (storageBackend !== "local" && storageBackend !== "s3") {
		throw new ConfigError("STORAGE_BACKEND must be 'local' or 's3'");
	}

	if (!Number.isInteger(maxFileSize) || maxFileSize <= 0) {
		throw new ConfigError("MAX_FILE_SIZE must be a positive integer");
	}

	if (!Number.isInteger(maxFilesPerNote) || maxFilesPerNote <= 0) {
		throw new ConfigError("MAX_FILES_PER_NOTE must be a positive integer");
	}

	if (maxFilesPerNote > MAX_FILES_PER_NOTE) {
		throw new ConfigError(
			`MAX_FILES_PER_NOTE cannot exceed the protocol limit of ${String(MAX_FILES_PER_NOTE)}`,
		);
	}

	if (!Number.isInteger(storageQuotaBytes) || storageQuotaBytes < 0) {
		throw new ConfigError(
			"STORAGE_QUOTA_BYTES must be a non-negative integer (0 disables the quota)",
		);
	}

	// Operators may tighten retention below the protocol ceiling, never above it.
	if (
		!Number.isInteger(maxExpirySeconds) ||
		maxExpirySeconds < MIN_EXPIRY_SECONDS ||
		maxExpirySeconds > MAX_EXPIRY_SECONDS
	) {
		throw new ConfigError(
			`MAX_EXPIRY must be an integer between ${String(MIN_EXPIRY_SECONDS)} and ${String(MAX_EXPIRY_SECONDS)} seconds`,
		);
	}

	if (Number.isNaN(chunkSize) || chunkSize <= 0) {
		throw new ConfigError("CHUNK_SIZE must be a positive number");
	}

	if (Number.isNaN(maxChunkedFileSize) || maxChunkedFileSize <= 0) {
		throw new ConfigError("MAX_CHUNKED_FILE_SIZE must be a positive number");
	}

	if (chunkSize > maxChunkedFileSize) {
		throw new ConfigError("CHUNK_SIZE must be less than or equal to MAX_CHUNKED_FILE_SIZE");
	}

	if (!(rateLimitMultiplier > 0) || rateLimitMultiplier > 100) {
		throw new ConfigError("RATE_LIMIT_MULTIPLIER must be a number between 0 (exclusive) and 100");
	}

	try {
		buildTrustedBlockList(trustedProxies);
	} catch (err) {
		// buildTrustedBlockList only ever throws Error instances.
		throw new ConfigError(`TRUSTED_PROXIES contains an invalid entry: ${(err as Error).message}`);
	}

	if (storageBackend === "s3" && (!s3Bucket || !s3AccessKeyId || !s3SecretAccessKey)) {
		throw new ConfigError(
			"S3_BUCKET, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY are required when STORAGE_BACKEND=s3",
		);
	}

	const storage: StorageConfig =
		storageBackend === "s3"
			? {
					type: "s3",
					s3: {
						bucket: s3Bucket,
						region: s3Region,
						...(s3Endpoint ? { endpoint: s3Endpoint } : {}),
						accessKeyId: s3AccessKeyId,
						secretAccessKey: s3SecretAccessKey,
						forcePathStyle: s3ForcePathStyle,
					},
				}
			: { type: "local", localPath: filesPath };

	return {
		port,
		host,
		databasePath,
		filesPath,
		appUrl: withoutTrailingSlashes(appUrl.href),
		serverKey,
		cleanupIntervalMs,
		capDifficulty,
		capChallengeCount,
		apiKeys,
		storageBackend,
		storage,
		storageReconcile,
		maxFileSize,
		maxFilesPerNote,
		storageQuotaBytes,
		maxExpirySeconds,
		chunkSize,
		maxChunkedFileSize,
		trustedProxies,
		rateLimitMultiplier,
		allowServerKeyChange,
		debug,
		metricsToken,
		shutdownTimeoutMs: shutdownTimeout * 1000,
	};
}

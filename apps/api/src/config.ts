import {
	CLEANUP_INTERVAL_MS,
	DEFAULT_CAP_CHALLENGE_COUNT,
	DEFAULT_CAP_DIFFICULTY,
	DEFAULT_CHUNK_SIZE,
	DEFAULT_MAX_CHUNKED_SIZE,
	MAX_FILE_SIZE,
	MAX_FILES_PER_NOTE,
} from "@largerio/secret-shared";
import { buildTrustedBlockList } from "./middleware/rateLimit.js";
import type { StorageConfig, StorageType } from "./storage/index.js";

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
	readonly appUrl: string;
	/** Raw SERVER_ENCRYPTION_KEY; decoded into a Buffer by the entry point. */
	readonly serverKey: string;
	readonly cleanupIntervalMs: number;
	readonly capDifficulty: number;
	readonly capChallengeCount: number;
	readonly apiKeys: ReadonlyArray<string>;
	readonly storageBackend: StorageType;
	readonly storage: StorageConfig;
	readonly maxFileSize: number;
	readonly maxFilesPerNote: number;
	readonly chunkSize: number;
	readonly maxChunkedFileSize: number;
	readonly trustedProxies: ReadonlyArray<string>;
	readonly debug: boolean;
}

/**
 * Parse and validate configuration from a process environment. Throws
 * {@link ConfigError} on any invalid value so the caller can decide how to
 * surface it (the entry point logs + exits; tests assert on the message).
 */
export function parseConfig(env: NodeJS.ProcessEnv): AppConfig {
	const port = Number(env["PORT"] ?? "3001");
	const host = env["HOST"] ?? "0.0.0.0";
	const databasePath = env["DATABASE_PATH"] ?? "./data/secret.db";
	const filesPath = env["FILES_PATH"] ?? "./data/files";
	const serverKey = env["SERVER_ENCRYPTION_KEY"];
	const appUrl = env["APP_URL"] ?? `http://localhost:${String(port)}`;
	const cleanupIntervalMs = Number(env["CLEANUP_INTERVAL_MS"] ?? String(CLEANUP_INTERVAL_MS));
	const capDifficulty = Number(env["CAP_DIFFICULTY"] ?? String(DEFAULT_CAP_DIFFICULTY));
	const capChallengeCount = Number(
		env["CAP_CHALLENGE_COUNT"] ?? String(DEFAULT_CAP_CHALLENGE_COUNT),
	);

	const apiKeys = Object.entries(env)
		.filter(([key]) => /^API_KEY(_\d+)?$/.test(key))
		.map(([, value]) => value?.trim())
		.filter((v): v is string => Boolean(v));

	const storageBackend = (env["STORAGE_BACKEND"] ?? "local") as StorageType;
	const s3Bucket = env["S3_BUCKET"] ?? "";
	const s3Region = env["S3_REGION"] ?? "us-east-1";
	const s3Endpoint = env["S3_ENDPOINT"];
	const s3AccessKeyId = env["S3_ACCESS_KEY_ID"] ?? "";
	const s3SecretAccessKey = env["S3_SECRET_ACCESS_KEY"] ?? "";
	const s3ForcePathStyle = env["S3_FORCE_PATH_STYLE"] === "true";

	const maxFileSize = Number(env["MAX_FILE_SIZE"] ?? String(MAX_FILE_SIZE));
	const maxFilesPerNote = Number(env["MAX_FILES_PER_NOTE"] ?? String(MAX_FILES_PER_NOTE));
	const chunkSize = Number(env["CHUNK_SIZE"] ?? String(DEFAULT_CHUNK_SIZE));
	const maxChunkedFileSize = Number(
		env["MAX_CHUNKED_FILE_SIZE"] ?? String(DEFAULT_MAX_CHUNKED_SIZE),
	);
	const trustedProxies = (env["TRUSTED_PROXIES"] ?? "")
		.split(",")
		.map((v) => v.trim())
		.filter((v) => v.length > 0);

	if (!serverKey) {
		throw new ConfigError(
			"SERVER_ENCRYPTION_KEY is required.",
			"Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
		);
	}

	if (Number.isNaN(port) || port <= 0) {
		throw new ConfigError("PORT must be a positive number");
	}

	if (Number.isNaN(cleanupIntervalMs) || cleanupIntervalMs <= 0) {
		throw new ConfigError("CLEANUP_INTERVAL_MS must be a positive number");
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

	if (Number.isNaN(chunkSize) || chunkSize <= 0) {
		throw new ConfigError("CHUNK_SIZE must be a positive number");
	}

	if (Number.isNaN(maxChunkedFileSize) || maxChunkedFileSize <= 0) {
		throw new ConfigError("MAX_CHUNKED_FILE_SIZE must be a positive number");
	}

	if (chunkSize > maxChunkedFileSize) {
		throw new ConfigError("CHUNK_SIZE must be less than or equal to MAX_CHUNKED_FILE_SIZE");
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
		appUrl,
		serverKey,
		cleanupIntervalMs,
		capDifficulty,
		capChallengeCount,
		apiKeys,
		storageBackend,
		storage,
		maxFileSize,
		maxFilesPerNote,
		chunkSize,
		maxChunkedFileSize,
		trustedProxies,
		debug: env["DEBUG"] === "1" || env["DEBUG"] === "true",
	};
}

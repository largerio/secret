import {
	CLEANUP_INTERVAL_MS,
	DEFAULT_CAP_CHALLENGE_COUNT,
	DEFAULT_CAP_DIFFICULTY,
	DEFAULT_CHUNK_SIZE,
	DEFAULT_MAX_CHUNKED_SIZE,
	MAX_FILE_SIZE,
	MAX_FILES_PER_NOTE,
} from "@largerio/shared";
import { describe, expect, it } from "vitest";
import { type AppConfig, ConfigError, parseConfig } from "../config.js";

type Env = NodeJS.ProcessEnv;

/** A minimal environment that parses successfully (only the required key set). */
function baseEnv(overrides: Record<string, string | undefined> = {}): Env {
	return { SERVER_ENCRYPTION_KEY: "test-key", ...overrides } as Env;
}

function expectConfigError(env: Env, message: string): ConfigError {
	let caught: unknown;
	try {
		parseConfig(env);
	} catch (err) {
		caught = err;
	}
	expect(caught).toBeInstanceOf(ConfigError);
	expect((caught as ConfigError).message).toBe(message);
	return caught as ConfigError;
}

describe("parseConfig", () => {
	describe("defaults", () => {
		it("returns sensible defaults when only the server key is set", () => {
			const config: AppConfig = parseConfig(baseEnv());

			expect(config).toMatchObject({
				port: 3001,
				host: "0.0.0.0",
				databasePath: "./data/secret.db",
				filesPath: "./data/files",
				appUrl: "http://localhost:3001",
				serverKey: "test-key",
				cleanupIntervalMs: CLEANUP_INTERVAL_MS,
				capDifficulty: DEFAULT_CAP_DIFFICULTY,
				capChallengeCount: DEFAULT_CAP_CHALLENGE_COUNT,
				apiKeys: [],
				storageBackend: "local",
				maxFileSize: MAX_FILE_SIZE,
				maxFilesPerNote: MAX_FILES_PER_NOTE,
				chunkSize: DEFAULT_CHUNK_SIZE,
				maxChunkedFileSize: DEFAULT_MAX_CHUNKED_SIZE,
				trustedProxies: [],
				debug: false,
			});
			expect(config.storage).toEqual({ type: "local", localPath: "./data/files" });
		});

		it("derives appUrl from a custom PORT", () => {
			const config = parseConfig(baseEnv({ PORT: "8080" }));
			expect(config.port).toBe(8080);
			expect(config.appUrl).toBe("http://localhost:8080");
		});

		it("honors an explicit APP_URL over the derived default", () => {
			const config = parseConfig(baseEnv({ APP_URL: "https://secret.example" }));
			expect(config.appUrl).toBe("https://secret.example");
		});
	});

	describe("API key collection", () => {
		it("collects API_KEY and numbered variants, trimming and dropping blanks", () => {
			const config = parseConfig(
				baseEnv({
					API_KEY: " key0 ",
					API_KEY_1: "key1",
					API_KEY_2: "   ",
					API_KEY_9: undefined,
					NOT_AN_API_KEY: "ignored",
				}),
			);
			expect(config.apiKeys).toEqual(["key0", "key1"]);
		});
	});

	describe("debug flag", () => {
		it.each([
			["1", true],
			["true", true],
			["0", false],
			[undefined, false],
		])("DEBUG=%s -> %s", (value, expected) => {
			const config = parseConfig(baseEnv(value === undefined ? {} : { DEBUG: value }));
			expect(config.debug).toBe(expected);
		});
	});

	describe("validation errors", () => {
		it("requires SERVER_ENCRYPTION_KEY and attaches a hint", () => {
			const err = expectConfigError(
				{ SERVER_ENCRYPTION_KEY: "" } as Env,
				"SERVER_ENCRYPTION_KEY is required.",
			);
			expect(err.hint).toContain("randomBytes(32)");
		});

		it.each([
			[{ PORT: "0" }, "PORT must be a positive number"],
			[{ PORT: "-1" }, "PORT must be a positive number"],
			[{ PORT: "abc" }, "PORT must be a positive number"],
			[{ CLEANUP_INTERVAL_MS: "0" }, "CLEANUP_INTERVAL_MS must be a positive number"],
			[{ CLEANUP_INTERVAL_MS: "nope" }, "CLEANUP_INTERVAL_MS must be a positive number"],
			[{ CAP_DIFFICULTY: "0" }, "CAP_DIFFICULTY must be an integer between 1 and 6"],
			[{ CAP_DIFFICULTY: "7" }, "CAP_DIFFICULTY must be an integer between 1 and 6"],
			[{ CAP_DIFFICULTY: "2.5" }, "CAP_DIFFICULTY must be an integer between 1 and 6"],
			[{ CAP_CHALLENGE_COUNT: "0" }, "CAP_CHALLENGE_COUNT must be a positive integer"],
			[{ CAP_CHALLENGE_COUNT: "1.5" }, "CAP_CHALLENGE_COUNT must be a positive integer"],
			[{ STORAGE_BACKEND: "azure" }, "STORAGE_BACKEND must be 'local' or 's3'"],
			[{ MAX_FILE_SIZE: "0" }, "MAX_FILE_SIZE must be a positive integer"],
			[{ MAX_FILE_SIZE: "1.5" }, "MAX_FILE_SIZE must be a positive integer"],
			[{ MAX_FILES_PER_NOTE: "0" }, "MAX_FILES_PER_NOTE must be a positive integer"],
			[{ MAX_FILES_PER_NOTE: "2.2" }, "MAX_FILES_PER_NOTE must be a positive integer"],
			[{ CHUNK_SIZE: "0" }, "CHUNK_SIZE must be a positive number"],
			[{ CHUNK_SIZE: "x" }, "CHUNK_SIZE must be a positive number"],
			[{ MAX_CHUNKED_FILE_SIZE: "0" }, "MAX_CHUNKED_FILE_SIZE must be a positive number"],
			[{ MAX_CHUNKED_FILE_SIZE: "y" }, "MAX_CHUNKED_FILE_SIZE must be a positive number"],
			[
				{ CHUNK_SIZE: "100", MAX_CHUNKED_FILE_SIZE: "50" },
				"CHUNK_SIZE must be less than or equal to MAX_CHUNKED_FILE_SIZE",
			],
		])("rejects %o", (overrides, message) => {
			expectConfigError(baseEnv(overrides as Record<string, string>), message);
		});

		it("rejects an invalid TRUSTED_PROXIES entry with the underlying detail", () => {
			const err = expectConfigError(
				baseEnv({ TRUSTED_PROXIES: "not-an-ip" }),
				"TRUSTED_PROXIES contains an invalid entry: Invalid trusted proxy address: not-an-ip",
			);
			expect(err).toBeInstanceOf(ConfigError);
		});

		it("requires S3 credentials when STORAGE_BACKEND=s3", () => {
			expectConfigError(
				baseEnv({ STORAGE_BACKEND: "s3" }),
				"S3_BUCKET, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY are required when STORAGE_BACKEND=s3",
			);
		});
	});

	describe("storage configuration", () => {
		it("accepts a fully specified S3 backend including endpoint", () => {
			const config = parseConfig(
				baseEnv({
					STORAGE_BACKEND: "s3",
					S3_BUCKET: "my-bucket",
					S3_REGION: "eu-west-1",
					S3_ENDPOINT: "https://s3.example",
					S3_ACCESS_KEY_ID: "akid",
					S3_SECRET_ACCESS_KEY: "secret",
					S3_FORCE_PATH_STYLE: "true",
				}),
			);
			expect(config.storageBackend).toBe("s3");
			expect(config.storage).toEqual({
				type: "s3",
				s3: {
					bucket: "my-bucket",
					region: "eu-west-1",
					endpoint: "https://s3.example",
					accessKeyId: "akid",
					secretAccessKey: "secret",
					forcePathStyle: true,
				},
			});
		});

		it("omits the endpoint key when S3_ENDPOINT is unset and defaults path style to false", () => {
			const config = parseConfig(
				baseEnv({
					STORAGE_BACKEND: "s3",
					S3_BUCKET: "my-bucket",
					S3_ACCESS_KEY_ID: "akid",
					S3_SECRET_ACCESS_KEY: "secret",
				}),
			);
			expect(config.storage.type).toBe("s3");
			expect(config.storage.s3).not.toHaveProperty("endpoint");
			expect(config.storage.s3?.region).toBe("us-east-1");
			expect(config.storage.s3?.forcePathStyle).toBe(false);
		});

		it("accepts a valid TRUSTED_PROXIES CIDR list", () => {
			const config = parseConfig(baseEnv({ TRUSTED_PROXIES: "10.0.0.0/8, ::1" }));
			expect(config.trustedProxies).toEqual(["10.0.0.0/8", "::1"]);
		});
	});
});

import { describe, expect, it } from "vitest";
import { createStorageBackend } from "../storage/index.js";
import { LocalStorage } from "../storage/local.js";
import { S3Storage } from "../storage/s3.js";

describe("createStorageBackend", () => {
	it("returns LocalStorage when type is local", () => {
		const backend = createStorageBackend({ type: "local", localPath: "./data/test-factory" });
		expect(backend).toBeInstanceOf(LocalStorage);
	});

	it("returns S3Storage when type is s3", () => {
		const backend = createStorageBackend({
			type: "s3",
			s3: {
				bucket: "test-bucket",
				region: "us-east-1",
				accessKeyId: "test-key",
				secretAccessKey: "test-secret",
				forcePathStyle: false,
			},
		});
		expect(backend).toBeInstanceOf(S3Storage);
	});

	it("throws when type is s3 but no s3 config provided", () => {
		expect(() => createStorageBackend({ type: "s3" })).toThrow("S3 configuration is required");
	});

	it("throws when type is local but no localPath provided", () => {
		expect(() => createStorageBackend({ type: "local" })).toThrow("LOCAL path is required");
	});
});

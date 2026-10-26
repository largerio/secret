import { beforeEach, describe, expect, it, vi } from "vitest";
import { StorageNotFoundError } from "../storage/errors.js";
import { S3Storage } from "../storage/s3.js";

const mockSend = vi.fn();
const mockDestroy = vi.fn();
const mockDone = vi.fn().mockResolvedValue({});
/** Captures what S3Storage actually passes to the SDK client. */
const clientConfigs: unknown[] = [];

vi.mock("@aws-sdk/client-s3", () => {
	class MockNoSuchKey extends Error {
		readonly $metadata = { httpStatusCode: 404 };
		constructor() {
			super("NoSuchKey");
			this.name = "NoSuchKey";
		}
	}
	return {
		S3Client: class MockS3Client {
			send = mockSend;
			destroy = mockDestroy;
			constructor(config: unknown) {
				clientConfigs.push(config);
			}
		},
		HeadBucketCommand: class MockHeadBucketCommand {
			constructor(public params: unknown) {}
		},
		PutObjectCommand: class MockPutObjectCommand {
			constructor(public params: unknown) {}
		},
		GetObjectCommand: class MockGetObjectCommand {
			constructor(public params: unknown) {}
		},
		DeleteObjectCommand: class MockDeleteObjectCommand {
			constructor(public params: unknown) {}
		},
		DeleteObjectsCommand: class MockDeleteObjectsCommand {
			constructor(public params: unknown) {}
		},
		ListObjectsV2Command: class MockListObjectsV2Command {
			constructor(public params: unknown) {}
		},
		NoSuchKey: MockNoSuchKey,
	};
});

const { NoSuchKey } = await import("@aws-sdk/client-s3");
const MockNoSuchKey = NoSuchKey as unknown as new () => Error;

vi.mock("@aws-sdk/lib-storage", () => ({
	Upload: class MockUpload {
		done = mockDone;
	},
}));

/** The parameters of the nth command sent to the SDK client. */
function params(call: number): unknown {
	return (mockSend.mock.calls[call]?.[0] as { params?: unknown } | undefined)?.params;
}

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
	const collected: T[] = [];
	for await (const item of items) {
		collected.push(item);
	}
	return collected;
}

const config = {
	bucket: "test-bucket",
	region: "us-east-1",
	accessKeyId: "test-key",
	secretAccessKey: "test-secret",
	forcePathStyle: false,
};

describe("S3Storage", () => {
	let storage: S3Storage;

	beforeEach(() => {
		vi.clearAllMocks();
		clientConfigs.length = 0;
		storage = new S3Storage(config);
	});

	it("forwards credentials and region to the SDK client", () => {
		// A swapped accessKeyId/secretAccessKey would otherwise pass every test.
		expect(clientConfigs.at(-1)).toMatchObject({
			region: "us-east-1",
			forcePathStyle: false,
			credentials: { accessKeyId: "test-key", secretAccessKey: "test-secret" },
		});
		expect(clientConfigs.at(-1)).not.toHaveProperty("endpoint");
	});

	it("passes a custom endpoint through and enables path style", () => {
		new S3Storage({ ...config, endpoint: "https://s3.local:9000", forcePathStyle: true });
		expect(clientConfigs.at(-1)).toMatchObject({
			endpoint: "https://s3.local:9000",
			forcePathStyle: true,
		});
	});

	describe("probe", () => {
		it("issues a HeadBucket against the configured bucket", async () => {
			mockSend.mockResolvedValueOnce({});
			await storage.probe();
			expect(mockSend).toHaveBeenCalledWith(
				expect.objectContaining({ params: { Bucket: "test-bucket" } }),
			);
		});

		it("propagates a failure so the health endpoint can report it", async () => {
			mockSend.mockRejectedValueOnce(new Error("InvalidAccessKeyId"));
			await expect(storage.probe()).rejects.toThrow("InvalidAccessKeyId");
		});
	});

	describe("save", () => {
		it("returns the S3 key", async () => {
			const key = await storage.save("note123", Buffer.from("encrypted-data"));
			expect(key).toBe("notes/note123");
		});

		it("rejects note ID with invalid characters", async () => {
			await expect(storage.save("../etc/passwd", Buffer.from("x"))).rejects.toThrow(
				"Invalid id for storage key",
			);
		});

		it("rejects note ID with spaces", async () => {
			await expect(storage.save("note id", Buffer.from("x"))).rejects.toThrow(
				"Invalid id for storage key",
			);
		});
	});

	describe("read", () => {
		it("returns the file data as Buffer", async () => {
			const testData = new Uint8Array([1, 2, 3, 4, 5]);
			const mockStream = new ReadableStream({
				start(controller) {
					controller.enqueue(testData);
					controller.close();
				},
			});

			mockSend.mockResolvedValueOnce({
				Body: { transformToWebStream: () => mockStream },
			});

			const result = await storage.read("notes/note123");
			expect(Buffer.isBuffer(result)).toBe(true);
			expect(result).toEqual(Buffer.from(testData));
		});

		it("throws when response body is empty", async () => {
			mockSend.mockResolvedValueOnce({ Body: null });

			await expect(storage.read("notes/note123")).rejects.toThrow("Empty response from S3");
		});

		it("maps NoSuchKey into StorageNotFoundError", async () => {
			mockSend.mockRejectedValueOnce(new MockNoSuchKey());
			await expect(storage.read("notes/missing")).rejects.toBeInstanceOf(StorageNotFoundError);
		});

		it("maps any 404 S3 response into StorageNotFoundError", async () => {
			const err = Object.assign(new Error("NotFound"), {
				name: "NotFound",
				$metadata: { httpStatusCode: 404 },
			});
			mockSend.mockRejectedValueOnce(err);
			await expect(storage.read("notes/missing")).rejects.toBeInstanceOf(StorageNotFoundError);
		});

		it("re-throws non-404 S3 errors as-is", async () => {
			const err = Object.assign(new Error("AccessDenied"), {
				name: "AccessDenied",
				$metadata: { httpStatusCode: 403 },
			});
			mockSend.mockRejectedValueOnce(err);
			await expect(storage.read("notes/forbidden")).rejects.not.toBeInstanceOf(
				StorageNotFoundError,
			);
		});

		it("maps a 404 even when the error name is generic", async () => {
			const err = Object.assign(new Error("boom"), {
				name: "UnknownError",
				$metadata: { httpStatusCode: 404 },
			});
			mockSend.mockRejectedValueOnce(err);
			await expect(storage.read("notes/missing")).rejects.toBeInstanceOf(StorageNotFoundError);
		});

		it("re-throws primitive rejections as-is", async () => {
			mockSend.mockRejectedValueOnce("plain-string");
			await expect(storage.read("notes/x")).rejects.toBe("plain-string");
		});
	});

	describe("saveChunk", () => {
		it("sends PutObject with correct key", async () => {
			mockSend.mockResolvedValueOnce({});
			const key = await storage.saveChunk("note123", 0, Buffer.from("chunk-data"));
			expect(key).toBe("notes/note123/chunk_0");
			expect(mockSend).toHaveBeenCalledOnce();
			const cmd = mockSend.mock.calls[0]?.[0];
			expect(cmd.params).toEqual({
				Bucket: "test-bucket",
				Key: "notes/note123/chunk_0",
				Body: Buffer.from("chunk-data"),
				ContentType: "application/octet-stream",
			});
		});

		it("rejects note ID with invalid characters", async () => {
			await expect(storage.saveChunk("../bad", 0, Buffer.from("x"))).rejects.toThrow(
				"Invalid id for storage key",
			);
		});

		it("rejects negative or non-integer chunk index", async () => {
			await expect(storage.saveChunk("note123", -1, Buffer.from("x"))).rejects.toThrow(
				"Invalid chunk index",
			);
			await expect(storage.saveChunk("note123", 1.5, Buffer.from("x"))).rejects.toThrow(
				"Invalid chunk index",
			);
		});
	});

	describe("readChunk", () => {
		it("sends GetObject with correct key and returns buffer", async () => {
			const testData = new Uint8Array([10, 20, 30]);
			const mockStream = new ReadableStream({
				start(controller) {
					controller.enqueue(testData);
					controller.close();
				},
			});
			mockSend.mockResolvedValueOnce({
				Body: { transformToWebStream: () => mockStream },
			});

			const result = await storage.readChunk("note123", 2);
			expect(Buffer.isBuffer(result)).toBe(true);
			expect(result).toEqual(Buffer.from(testData));

			const cmd = mockSend.mock.calls[0]?.[0];
			expect(cmd.params).toEqual({
				Bucket: "test-bucket",
				Key: "notes/note123/chunk_2",
			});
		});

		it("throws when response body is empty", async () => {
			mockSend.mockResolvedValueOnce({ Body: null });
			await expect(storage.readChunk("note123", 0)).rejects.toThrow("Empty response from S3");
		});

		it("maps NoSuchKey into StorageNotFoundError", async () => {
			mockSend.mockRejectedValueOnce(new MockNoSuchKey());
			await expect(storage.readChunk("note123", 0)).rejects.toBeInstanceOf(StorageNotFoundError);
		});

		it("re-throws non-404 S3 errors as-is", async () => {
			const err = Object.assign(new Error("Throttled"), {
				name: "SlowDown",
				$metadata: { httpStatusCode: 503 },
			});
			mockSend.mockRejectedValueOnce(err);
			await expect(storage.readChunk("note123", 0)).rejects.not.toBeInstanceOf(
				StorageNotFoundError,
			);
		});

		it("rejects invalid note ID before issuing the GetObject", async () => {
			await expect(storage.readChunk("../bad", 0)).rejects.toThrow("Invalid id for storage key");
			expect(mockSend).not.toHaveBeenCalled();
		});

		it("rejects negative chunk index", async () => {
			await expect(storage.readChunk("note123", -1)).rejects.toThrow("Invalid chunk index");
		});
	});

	describe("purge", () => {
		it("lists the note's objects and deletes them, file and chunks alike", async () => {
			mockSend
				.mockResolvedValueOnce({
					Contents: [
						{ Key: "notes/note123" },
						{ Key: "notes/note123/chunk_0" },
						{ Key: "notes/note1234" },
						{},
					],
				})
				.mockResolvedValueOnce({});

			await storage.purge("note123");

			expect(params(0)).toEqual({ Bucket: "test-bucket", Prefix: "notes/note123" });
			// notes/note1234 matches the prefix but belongs to another note.
			expect(params(1)).toEqual({
				Bucket: "test-bucket",
				Delete: {
					Objects: [{ Key: "notes/note123" }, { Key: "notes/note123/chunk_0" }],
					Quiet: true,
				},
			});
		});

		it("follows the listing across pages, deleting each one", async () => {
			mockSend
				.mockResolvedValueOnce({
					Contents: [{ Key: "notes/note123/chunk_0" }, { Key: "notes/note123/chunk_1" }],
					NextContinuationToken: "page-2",
				})
				.mockResolvedValueOnce({})
				.mockResolvedValueOnce({
					Contents: [{ Key: "notes/note123/chunk_2" }, { Key: "notes/note123/chunk_3" }],
				})
				.mockResolvedValueOnce({});

			await storage.purge("note123");

			expect(params(2)).toEqual({
				Bucket: "test-bucket",
				Prefix: "notes/note123",
				ContinuationToken: "page-2",
			});
			expect(params(3)).toMatchObject({
				Delete: { Objects: [{ Key: "notes/note123/chunk_2" }, { Key: "notes/note123/chunk_3" }] },
			});
		});

		it("deletes a lone object with a plain DELETE, which every S3 server accepts", async () => {
			mockSend
				.mockResolvedValueOnce({ Contents: [{ Key: "notes/note123" }] })
				.mockResolvedValueOnce({});

			await storage.purge("note123");

			expect(params(1)).toEqual({ Bucket: "test-bucket", Key: "notes/note123" });
		});

		it("counts a lone object already gone as deleted", async () => {
			mockSend
				.mockResolvedValueOnce({ Contents: [{ Key: "notes/note123" }] })
				.mockRejectedValueOnce(new MockNoSuchKey());

			await expect(storage.purge("note123")).resolves.toBeUndefined();
		});

		it("propagates any other failure to delete a lone object", async () => {
			mockSend
				.mockResolvedValueOnce({ Contents: [{ Key: "notes/note123" }] })
				.mockRejectedValueOnce(new Error("AccessDenied"));

			await expect(storage.purge("note123")).rejects.toThrow("AccessDenied");
		});

		it("sends no delete when nothing is stored", async () => {
			mockSend.mockResolvedValueOnce({});
			await storage.purge("note123");
			expect(mockSend).toHaveBeenCalledOnce();
		});

		it("rejects when S3 refuses a key, though the response is a 200", async () => {
			mockSend
				.mockResolvedValueOnce({
					Contents: [{ Key: "notes/note123" }, { Key: "notes/note123/chunk_0" }],
				})
				.mockResolvedValueOnce({
					Errors: [
						{ Key: "notes/note123", Code: "AccessDenied" },
						{ Key: "notes/note123/chunk_0" },
					],
				});
			await expect(storage.purge("note123")).rejects.toThrow(
				"S3 refused to delete 2 object(s): AccessDenied",
			);
		});

		it("names an unknown error when S3 gives no code", async () => {
			mockSend
				.mockResolvedValueOnce({
					Contents: [{ Key: "notes/note123" }, { Key: "notes/note123/chunk_0" }],
				})
				.mockResolvedValueOnce({ Errors: [{ Key: "notes/note123" }] });
			await expect(storage.purge("note123")).rejects.toThrow("1 object(s): unknown error");
		});

		it("counts a key already gone as deleted", async () => {
			mockSend
				.mockResolvedValueOnce({
					Contents: [{ Key: "notes/note123" }, { Key: "notes/note123/chunk_0" }],
				})
				.mockResolvedValueOnce({ Errors: [{ Key: "notes/note123", Code: "NoSuchKey" }] });
			await expect(storage.purge("note123")).resolves.toBeUndefined();
		});

		it("propagates a failed listing or delete", async () => {
			mockSend.mockRejectedValueOnce(new Error("S3 error"));
			await expect(storage.purge("note123")).rejects.toThrow("S3 error");
		});

		it("rejects an invalid note ID before calling S3", async () => {
			await expect(storage.purge("../bad")).rejects.toThrow("Invalid id for storage key");
			expect(mockSend).not.toHaveBeenCalled();
		});
	});

	describe("list", () => {
		const t1 = new Date("2026-10-01T00:00:00Z");
		const t2 = new Date("2026-10-02T00:00:00Z");

		it("folds a note's objects into one entry dated by the latest, across pages", async () => {
			mockSend
				.mockResolvedValueOnce({
					Contents: [
						{ Key: "notes/aaaaaaaaaaaa", LastModified: t1 },
						{ Key: "notes/bbbbbbbbbbbb/chunk_0", LastModified: t2 },
					],
					NextContinuationToken: "page-2",
				})
				.mockResolvedValueOnce({
					Contents: [
						{ Key: "notes/bbbbbbbbbbbb/chunk_1", LastModified: t1 },
						{ Key: "notes/cccccccccccc/chunk_0", LastModified: t1 },
						{ Key: "notes/cccccccccccc/chunk_1", LastModified: t2 },
					],
				});

			expect(await collect(storage.list())).toEqual([
				{ noteId: "aaaaaaaaaaaa", lastModified: t1 },
				{ noteId: "bbbbbbbbbbbb", lastModified: t2 },
				{ noteId: "cccccccccccc", lastModified: t2 },
			]);
			expect(params(0)).toEqual({ Bucket: "test-bucket", Prefix: "notes/" });
			expect(params(1)).toMatchObject({ ContinuationToken: "page-2" });
		});

		it("skips keys outside the layout Secret writes", async () => {
			mockSend.mockResolvedValueOnce({
				Contents: [
					{ Key: "notes/short", LastModified: t1 },
					{ Key: "notes/aaaaaaaaaaaa/other", LastModified: t1 },
					{ Key: "notes/aaaaaaaaaaaa/chunk_x", LastModified: t1 },
					{ Key: "notes/bbbbbbbbbbbb" },
					{ LastModified: t1 },
				],
			});

			expect(await collect(storage.list())).toEqual([]);
		});

		it("yields nothing for an empty bucket", async () => {
			mockSend.mockResolvedValueOnce({});
			expect(await collect(storage.list())).toEqual([]);
		});
	});

	describe("claims", () => {
		it("records a claim as an empty object under instances/", async () => {
			mockSend.mockResolvedValueOnce({});
			await storage.claim("instance-a");
			expect(params(0)).toEqual({
				Bucket: "test-bucket",
				Key: "instances/instance-a",
				Body: Buffer.alloc(0),
			});
		});

		it("rejects an invalid instance id", async () => {
			await expect(storage.claim("../x")).rejects.toThrow("Invalid id for storage key");
		});

		it("lists claims by instance id", async () => {
			mockSend.mockResolvedValueOnce({
				Contents: [{ Key: "instances/instance-a" }, { Key: "instances/" }, {}],
				NextContinuationToken: "page-2",
			});
			mockSend.mockResolvedValueOnce({ Contents: [{ Key: "instances/instance-b" }] });

			expect(await storage.listClaims()).toEqual(["instance-a", "instance-b"]);
			expect(params(0)).toEqual({ Bucket: "test-bucket", Prefix: "instances/" });
		});
	});

	describe("close", () => {
		it("destroys the underlying S3 client", async () => {
			await storage.close();
			expect(mockDestroy).toHaveBeenCalledTimes(1);
		});
	});
});

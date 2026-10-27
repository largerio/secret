import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StorageNotFoundError } from "../storage/errors.js";
import { S3_TIMEOUTS, S3Storage } from "../storage/s3.js";

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

/** The nth command sent to the SDK client: its class (mock names) and parameters. */
function sent(call: number): { command: string; params: unknown } {
	const command = mockSend.mock.calls[call]?.[0] as { params?: unknown } | undefined;
	return { command: command?.constructor.name ?? "none", params: command?.params };
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

	it("bounds how long the SDK client waits on a silent endpoint", () => {
		// socketTimeout, not requestTimeout: that one is a deadline on the whole
		// request, which only logs a warning unless told to throw.
		expect(clientConfigs.at(-1)).toMatchObject({
			requestHandler: { connectionTimeout: 5_000, socketTimeout: 30_000 },
		});
		expect(S3_TIMEOUTS).toEqual({
			connectionMs: 5_000,
			idleMs: 30_000,
			requestMs: 120_000,
			probeMs: 5_000,
		});
	});

	describe("the request deadline", () => {
		/** The command sent and the abort signal it was given, call by call. */
		function sentWithSignals(): Array<{ command: string; abortSignal: unknown }> {
			return mockSend.mock.calls.map(([command, options]) => ({
				command: (command as object).constructor.name,
				abortSignal: (options as { abortSignal?: unknown } | undefined)?.abortSignal,
			}));
		}

		it("is given to every request that moves no note payload, each its own", async () => {
			const timeout = vi.spyOn(AbortSignal, "timeout");
			mockSend
				// purge: the file object, a listing, a refused batch, its key alone.
				.mockResolvedValueOnce({})
				.mockResolvedValueOnce({ Contents: [{ Key: "notes/note123/chunk_0" }] })
				.mockRejectedValueOnce(new Error("InvalidRequest"))
				.mockResolvedValueOnce({})
				// list, over two pages.
				.mockResolvedValueOnce({ NextContinuationToken: "page-2" })
				.mockResolvedValueOnce({})
				// claim, listClaims.
				.mockResolvedValueOnce({})
				.mockResolvedValueOnce({});

			await storage.purge("note123");
			await collect(storage.list());
			await storage.claim("instance-a");
			await storage.listClaims();

			const signals = timeout.mock.results.map((result) => result.value);
			const durations = [...timeout.mock.calls];
			timeout.mockRestore();

			expect(sentWithSignals().map(({ command }) => command)).toEqual([
				"MockDeleteObjectCommand",
				"MockListObjectsV2Command",
				"MockDeleteObjectsCommand",
				"MockDeleteObjectCommand",
				"MockListObjectsV2Command",
				"MockListObjectsV2Command",
				"MockPutObjectCommand",
				"MockListObjectsV2Command",
			]);
			expect(durations).toEqual(Array.from({ length: 8 }, () => [120_000]));
			for (const [index, { abortSignal }] of sentWithSignals().entries()) {
				expect(abortSignal).toBe(signals[index]);
			}
		});

		it("honors the bound it is given", async () => {
			const timeout = vi.spyOn(AbortSignal, "timeout");
			mockSend.mockResolvedValueOnce({});

			await new S3Storage(config, { ...S3_TIMEOUTS, requestMs: 1_000 }).claim("instance-a");

			const durations = [...timeout.mock.calls];
			timeout.mockRestore();
			expect(durations).toEqual([[1_000]]);
		});

		it("is not given to a read or a chunk upload: they take as long as their size", async () => {
			mockSend
				.mockResolvedValueOnce({ Body: null })
				.mockResolvedValueOnce({ Body: null })
				.mockResolvedValueOnce({});

			// No body: the request is all that matters here.
			await expect(storage.read("notes/note123")).rejects.toThrow("Empty response");
			await expect(storage.readChunk("note123", 0)).rejects.toThrow("Empty response");
			await storage.saveChunk("note123", 0, Buffer.from("chunk-data"));

			expect(sentWithSignals()).toEqual([
				{ command: "MockGetObjectCommand", abortSignal: undefined },
				{ command: "MockGetObjectCommand", abortSignal: undefined },
				{ command: "MockPutObjectCommand", abortSignal: undefined },
			]);
		});
	});

	describe("probe", () => {
		it("issues a HeadBucket against the configured bucket", async () => {
			mockSend.mockResolvedValueOnce({});
			await storage.probe();
			expect(mockSend).toHaveBeenCalledWith(
				expect.objectContaining({ params: { Bucket: "test-bucket" } }),
				expect.anything(),
			);
		});

		it("gives the probe, retries included, a deadline", async () => {
			const timeout = vi.spyOn(AbortSignal, "timeout");
			mockSend.mockResolvedValueOnce({});

			await storage.probe();

			const signal = timeout.mock.results[0]?.value;
			const options = mockSend.mock.calls[0]?.[1] as { abortSignal?: unknown } | undefined;
			const calls = [...timeout.mock.calls];
			timeout.mockRestore();

			expect(calls).toEqual([[5_000]]);
			expect(options?.abortSignal).toBe(signal);
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

	describe("a body that stops arriving", () => {
		afterEach(() => {
			vi.useRealTimers();
		});

		/** A body that sends `sent`, then nothing. */
		function stallingBody(sent: Uint8Array, cancel: () => void = vi.fn()) {
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(sent);
				},
				cancel,
			});
			return { Body: { transformToWebStream: () => stream } };
		}

		it("is given up after a silence, and its connection closed", async () => {
			vi.useFakeTimers();
			const cancel = vi.fn();
			mockSend.mockResolvedValueOnce(stallingBody(new Uint8Array([1, 2]), cancel));

			const reading = storage.read("notes/note123");
			const failed = expect(reading).rejects.toThrow("S3 response stalled for 30 s");
			await vi.advanceTimersByTimeAsync(30_000);

			await failed;
			expect(cancel).toHaveBeenCalledOnce();
		});

		it("is given up the same way on a chunk", async () => {
			vi.useFakeTimers();
			mockSend.mockResolvedValueOnce(stallingBody(new Uint8Array([3])));

			const reading = storage.readChunk("note123", 0);
			const failed = expect(reading).rejects.toThrow("S3 response stalled");
			await vi.advanceTimersByTimeAsync(30_000);

			await failed;
		});

		it("still fails cleanly when closing the stream fails too", async () => {
			vi.useFakeTimers();
			mockSend.mockResolvedValueOnce(
				stallingBody(new Uint8Array([1]), () => {
					throw new Error("cancel failed");
				}),
			);

			const reading = storage.read("notes/note123");
			const failed = expect(reading).rejects.toThrow("S3 response stalled");
			await vi.advanceTimersByTimeAsync(30_000);

			await failed;
		});

		it("is not a deadline: a slow body that keeps coming is read whole", async () => {
			vi.useFakeTimers();
			let sent = 0;
			const stream = new ReadableStream<Uint8Array>({
				async pull(controller) {
					// 25 s between chunks, 75 s in all: within the idle bound each time.
					await new Promise((resolve) => setTimeout(resolve, 25_000));
					if (sent === 3) {
						controller.close();
						return;
					}
					controller.enqueue(new Uint8Array([sent++]));
				},
			});
			mockSend.mockResolvedValueOnce({ Body: { transformToWebStream: () => stream } });

			const reading = storage.read("notes/note123");
			await vi.advanceTimersByTimeAsync(100_000);

			await expect(reading).resolves.toEqual(Buffer.from([0, 1, 2]));
			// Every read's timer is cleared once its chunk is in.
			expect(vi.getTimerCount()).toBe(0);
		});

		it("honors the idle bound it is given", async () => {
			vi.useFakeTimers();
			const quick = new S3Storage(config, { ...S3_TIMEOUTS, idleMs: 1_000 });
			mockSend.mockResolvedValueOnce(stallingBody(new Uint8Array([1])));

			const reading = quick.read("notes/note123");
			const failed = expect(reading).rejects.toThrow("S3 response stalled for 1 s");
			await vi.advanceTimersByTimeAsync(1_000);

			await failed;
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
		const fileDelete = {
			command: "MockDeleteObjectCommand",
			params: { Bucket: "test-bucket", Key: "notes/note123" },
		};
		const chunkListing = {
			command: "MockListObjectsV2Command",
			params: { Bucket: "test-bucket", Prefix: "notes/note123/" },
		};

		it("deletes a file note's object without listing it first", async () => {
			mockSend.mockResolvedValueOnce({}).mockResolvedValueOnce({});

			await storage.purge("note123");

			expect(sent(0)).toEqual(fileDelete);
			// Chunks are looked for under the id followed by a slash, so a longer
			// id that starts with this one is never matched.
			expect(sent(1)).toEqual(chunkListing);
			expect(mockSend).toHaveBeenCalledTimes(2);
		});

		it("deletes a chunked note's chunks in one batch per listing page", async () => {
			mockSend
				.mockResolvedValueOnce({})
				.mockResolvedValueOnce({
					Contents: [{ Key: "notes/note123/chunk_0" }, { Key: "notes/note123/chunk_1" }, {}],
					NextContinuationToken: "page-2",
				})
				.mockResolvedValueOnce({})
				.mockResolvedValueOnce({ Contents: [{ Key: "notes/note123/chunk_2" }] })
				.mockResolvedValueOnce({});

			await storage.purge("note123");

			expect(sent(2)).toEqual({
				command: "MockDeleteObjectsCommand",
				params: {
					Bucket: "test-bucket",
					Delete: {
						Objects: [{ Key: "notes/note123/chunk_0" }, { Key: "notes/note123/chunk_1" }],
						Quiet: true,
					},
				},
			});
			expect(sent(3)).toEqual({
				command: "MockListObjectsV2Command",
				params: { ...chunkListing.params, ContinuationToken: "page-2" },
			});
			expect(sent(4)).toMatchObject({
				command: "MockDeleteObjectsCommand",
				params: { Delete: { Objects: [{ Key: "notes/note123/chunk_2" }] } },
			});
		});

		it("counts a file object already gone as deleted", async () => {
			mockSend.mockRejectedValueOnce(new MockNoSuchKey()).mockResolvedValueOnce({});
			await expect(storage.purge("note123")).resolves.toBeUndefined();
		});

		it("propagates any other failure to delete the file object", async () => {
			mockSend.mockRejectedValueOnce(new Error("AccessDenied"));
			await expect(storage.purge("note123")).rejects.toThrow("AccessDenied");
		});

		it("propagates a failed listing", async () => {
			mockSend.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("S3 error"));
			await expect(storage.purge("note123")).rejects.toThrow("S3 error");
		});

		it("rejects when S3 refuses a key, though the response is a 200", async () => {
			mockSend
				.mockResolvedValueOnce({})
				.mockResolvedValueOnce({
					Contents: [{ Key: "notes/note123/chunk_0" }, { Key: "notes/note123/chunk_1" }],
				})
				.mockResolvedValueOnce({
					Errors: [
						{ Key: "notes/note123/chunk_0", Code: "AccessDenied" },
						{ Key: "notes/note123/chunk_1" },
					],
				});
			await expect(storage.purge("note123")).rejects.toThrow(
				"S3 refused to delete 2 object(s): AccessDenied",
			);
		});

		it("names an unknown error when S3 gives no code", async () => {
			mockSend
				.mockResolvedValueOnce({})
				.mockResolvedValueOnce({ Contents: [{ Key: "notes/note123/chunk_0" }] })
				.mockResolvedValueOnce({ Errors: [{ Key: "notes/note123/chunk_0" }] });
			await expect(storage.purge("note123")).rejects.toThrow("1 object(s): unknown error");
		});

		it("counts a key already gone as deleted", async () => {
			mockSend
				.mockResolvedValueOnce({})
				.mockResolvedValueOnce({ Contents: [{ Key: "notes/note123/chunk_0" }] })
				.mockResolvedValueOnce({ Errors: [{ Key: "notes/note123/chunk_0", Code: "NoSuchKey" }] });
			await expect(storage.purge("note123")).resolves.toBeUndefined();
		});

		it("falls back to one DELETE per key when the server refuses the batch call", async () => {
			mockSend
				.mockResolvedValueOnce({})
				.mockResolvedValueOnce({
					Contents: [{ Key: "notes/note123/chunk_0" }, { Key: "notes/note123/chunk_1" }],
				})
				.mockRejectedValueOnce(new Error("InvalidRequest"))
				.mockResolvedValueOnce({})
				.mockRejectedValueOnce(new MockNoSuchKey());

			await expect(storage.purge("note123")).resolves.toBeUndefined();

			expect([sent(3), sent(4)]).toEqual([
				{
					command: "MockDeleteObjectCommand",
					params: { Bucket: "test-bucket", Key: "notes/note123/chunk_0" },
				},
				{
					command: "MockDeleteObjectCommand",
					params: { Bucket: "test-bucket", Key: "notes/note123/chunk_1" },
				},
			]);
		});

		it("propagates a failure of the one-by-one deletes", async () => {
			mockSend
				.mockResolvedValueOnce({})
				.mockResolvedValueOnce({
					Contents: [{ Key: "notes/note123/chunk_0" }, { Key: "notes/note123/chunk_1" }],
				})
				.mockRejectedValueOnce(new Error("SlowDown"))
				.mockRejectedValueOnce(new Error("SlowDown"))
				.mockRejectedValueOnce(new Error("SlowDown"));

			await expect(storage.purge("note123")).rejects.toThrow("SlowDown");
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
			expect(sent(0)).toEqual({
				command: "MockListObjectsV2Command",
				params: { Bucket: "test-bucket", Prefix: "notes/" },
			});
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
			expect(sent(0)).toEqual({
				command: "MockPutObjectCommand",
				params: { Bucket: "test-bucket", Key: "instances/instance-a", Body: Buffer.alloc(0) },
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

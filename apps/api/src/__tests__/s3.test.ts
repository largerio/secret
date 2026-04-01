import { beforeEach, describe, expect, it, vi } from "vitest";
import { S3Storage } from "../storage/s3.js";

const mockSend = vi.fn();
const mockDone = vi.fn().mockResolvedValue({});

vi.mock("@aws-sdk/client-s3", () => {
	return {
		S3Client: class MockS3Client {
			send = mockSend;
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
	};
});

vi.mock("@aws-sdk/lib-storage", () => ({
	Upload: class MockUpload {
		done = mockDone;
	},
}));

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
		storage = new S3Storage(config);
	});

	it("accepts config with custom endpoint", () => {
		const s3 = new S3Storage({ ...config, endpoint: "https://minio.local:9000" });
		expect(s3).toBeDefined();
	});

	describe("save", () => {
		it("returns the S3 key", async () => {
			const key = await storage.save("note123", Buffer.from("encrypted-data"));
			expect(key).toBe("notes/note123");
		});

		it("rejects note ID with invalid characters", async () => {
			await expect(storage.save("../etc/passwd", Buffer.from("x"))).rejects.toThrow(
				"Invalid note ID for storage key",
			);
		});

		it("rejects note ID with spaces", async () => {
			await expect(storage.save("note id", Buffer.from("x"))).rejects.toThrow(
				"Invalid note ID for storage key",
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
	});

	describe("delete", () => {
		it("calls S3 delete command", async () => {
			mockSend.mockResolvedValueOnce({});
			await expect(storage.delete("notes/note123")).resolves.not.toThrow();
			expect(mockSend).toHaveBeenCalledOnce();
		});

		it("does not throw on delete error", async () => {
			mockSend.mockRejectedValueOnce(new Error("NoSuchKey"));
			await expect(storage.delete("notes/missing")).resolves.not.toThrow();
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
				"Invalid note ID for storage key",
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
	});

	describe("deleteChunks", () => {
		it("sends Delete for all chunk objects", async () => {
			mockSend.mockResolvedValue({});
			await storage.deleteChunks("note123", 3);
			expect(mockSend).toHaveBeenCalledTimes(3);

			const keys = mockSend.mock.calls.map(
				(call: Array<{ params: { Key: string } }>) => call[0]?.params?.Key,
			);
			expect(keys).toEqual([
				"notes/note123/chunk_0",
				"notes/note123/chunk_1",
				"notes/note123/chunk_2",
			]);
		});

		it("does not throw when individual chunk deletes fail", async () => {
			mockSend.mockRejectedValue(new Error("NoSuchKey"));
			await expect(storage.deleteChunks("note123", 2)).resolves.not.toThrow();
		});
	});
});

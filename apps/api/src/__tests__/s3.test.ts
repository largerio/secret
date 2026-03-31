import { describe, expect, it, vi, beforeEach } from "vitest";
import { S3Storage } from "../storage/s3.js";

const mockSend = vi.fn();
const mockDone = vi.fn().mockResolvedValue({});

vi.mock("@aws-sdk/client-s3", () => {
	return {
		S3Client: class MockS3Client {
			send = mockSend;
			constructor() {}
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
		constructor() {}
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

	describe("save", () => {
		it("returns the S3 key", async () => {
			const key = await storage.save("note123", Buffer.from("encrypted-data"));
			expect(key).toBe("notes/note123");
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
});

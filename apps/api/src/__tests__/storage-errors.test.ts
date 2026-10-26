import { describe, expect, it } from "vitest";
import {
	describeStorageError,
	StorageError,
	StorageInvalidKeyError,
	StorageNotFoundError,
} from "../storage/errors.js";

describe("storage errors", () => {
	it("StorageError carries a name and message", () => {
		const err = new StorageError("boom");
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("StorageError");
		expect(err.message).toBe("boom");
	});

	it("StorageInvalidKeyError extends StorageError", () => {
		const err = new StorageInvalidKeyError();
		expect(err).toBeInstanceOf(StorageError);
		expect(err).toBeInstanceOf(StorageInvalidKeyError);
		expect(err.name).toBe("StorageInvalidKeyError");
		expect(err.message).toBe("Invalid storage key");
	});

	it("StorageInvalidKeyError accepts a custom message", () => {
		const err = new StorageInvalidKeyError("custom");
		expect(err.message).toBe("custom");
	});

	it("StorageNotFoundError extends StorageError", () => {
		const err = new StorageNotFoundError();
		expect(err).toBeInstanceOf(StorageError);
		expect(err).toBeInstanceOf(StorageNotFoundError);
		expect(err.name).toBe("StorageNotFoundError");
		expect(err.message).toBe("Storage object not found");
	});

	it("StorageNotFoundError accepts a custom message", () => {
		const err = new StorageNotFoundError("custom");
		expect(err.message).toBe("custom");
	});
});

describe("describeStorageError", () => {
	it("keeps the message of the storage layer's own errors", () => {
		expect(
			describeStorageError(new StorageError("S3 refused to delete 1 object(s): AccessDenied")),
		).toBe("S3 refused to delete 1 object(s): AccessDenied");
	});

	it("gives a system error's code, never its message and the path in it", () => {
		const err = Object.assign(new Error("EROFS: read-only file system, rmdir '/data/abc'"), {
			code: "EROFS",
		});
		expect(describeStorageError(err)).toBe("EROFS");
	});

	it("gives the name of any other error", () => {
		const err = new Error("The specified key notes/abc does not exist.");
		err.name = "NoSuchKey";
		expect(describeStorageError(err)).toBe("NoSuchKey");
	});

	it("gives the type of a non-Error rejection", () => {
		expect(describeStorageError("notes/abc")).toBe("string");
		expect(describeStorageError(undefined)).toBe("undefined");
	});
});

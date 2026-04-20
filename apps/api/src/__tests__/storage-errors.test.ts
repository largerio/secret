import { describe, expect, it } from "vitest";
import { StorageError, StorageInvalidKeyError, StorageNotFoundError } from "../storage/errors.js";

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

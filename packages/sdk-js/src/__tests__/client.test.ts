import { beforeEach, describe, expect, test, vi } from "vitest";
import { SecretClient } from "../client.js";
import { SecretApiError, SecretDecryptionError } from "../errors.js";

vi.mock("../http.js", () => ({
	postJson: vi.fn(),
	postFormData: vi.fn(),
	getNote: vi.fn(),
	getNoteRaw: vi.fn(),
	checkNote: vi.fn(),
	deleteNote: vi.fn(),
}));

vi.mock("../crypto.js", () => ({
	ensureInit: vi.fn(() => Promise.resolve()),
	encryptNote: vi.fn(() =>
		Promise.resolve({
			encryptedData: "base64EncData",
			clientNonce: "base64Nonce",
			keyFragment: "base64urlKey",
		}),
	),
	decryptNote: vi.fn(() => Promise.resolve({ text: "decrypted text", contentMode: "text" })),
	decryptNoteBytes: vi.fn(() =>
		Promise.resolve({ text: "decrypted raw text", contentMode: "text" }),
	),
}));

async function getHttpMocks() {
	return (await import("../http.js")) as typeof import("../http.js") & {
		postJson: ReturnType<typeof vi.fn>;
		postFormData: ReturnType<typeof vi.fn>;
		getNote: ReturnType<typeof vi.fn>;
		getNoteRaw: ReturnType<typeof vi.fn>;
		checkNote: ReturnType<typeof vi.fn>;
		deleteNote: ReturnType<typeof vi.fn>;
	};
}

async function getCryptoMocks() {
	return (await import("../crypto.js")) as typeof import("../crypto.js") & {
		encryptNote: ReturnType<typeof vi.fn>;
		decryptNote: ReturnType<typeof vi.fn>;
		decryptNoteBytes: ReturnType<typeof vi.fn>;
	};
}

describe("SecretClient", () => {
	beforeEach(async () => {
		const http = await getHttpMocks();
		http.postJson.mockReset();
		http.postFormData.mockReset();
		http.getNote.mockReset();
		http.getNoteRaw.mockReset();
		http.checkNote.mockReset();
		http.deleteNote.mockReset();

		const crypto = await getCryptoMocks();
		crypto.encryptNote.mockReset();
		crypto.encryptNote.mockResolvedValue({
			encryptedData: "base64EncData",
			clientNonce: "base64Nonce",
			keyFragment: "base64urlKey",
		});
		crypto.decryptNote.mockReset();
		crypto.decryptNoteBytes.mockReset();
		crypto.decryptNoteBytes.mockResolvedValue({
			text: "decrypted raw text",
			contentMode: "text",
		});
	});
	test("creates a client with default config", async () => {
		const client = await SecretClient.create({ baseUrl: "https://example.com" });
		expect(client).toBeInstanceOf(SecretClient);
	});

	test("creates a client with no config (defaults)", async () => {
		const client = await SecretClient.create();
		expect(client).toBeInstanceOf(SecretClient);
	});

	test("checkNote delegates to http.checkNote", async () => {
		const http = await getHttpMocks();
		http.checkNote.mockResolvedValue({
			exists: true,
			hasPassword: false,
			fileCount: 0,
			expiresAt: "2099-01-01",
			maxReads: 1,
		});

		const client = await SecretClient.create({ baseUrl: "https://example.com" });
		const info = await client.checkNote("aBcDeFgHiJkL");

		expect(info.exists).toBe(true);
		expect(info.hasPassword).toBe(false);
		expect(http.checkNote).toHaveBeenCalled();
	});

	test("deleteNote delegates to http.deleteNote", async () => {
		const http = await getHttpMocks();
		http.deleteNote.mockRejectedValue(new SecretApiError("Invalid delete token", 403));

		const client = await SecretClient.create({ baseUrl: "https://example.com" });

		await expect(client.deleteNote("aBcDeFgHiJkL", "bad-token")).rejects.toThrow(SecretApiError);
	});

	test("passes apiKey through to httpConfig", async () => {
		const http = await getHttpMocks();
		http.checkNote.mockResolvedValue({
			exists: true,
			hasPassword: false,
			fileCount: 0,
			expiresAt: "2099-01-01",
			maxReads: 1,
		});

		const client = await SecretClient.create({
			baseUrl: "https://example.com",
			apiKey: "test-key-123",
		});

		await client.checkNote("aBcDeFgHiJkL");

		const config = http.checkNote.mock.calls[0]?.[0] as import("../http.js").HttpClientConfig;
		expect(config.apiKey).toBe("test-key-123");
	});

	test("buildShareUrl constructs correct URL", async () => {
		const client = await SecretClient.create({ baseUrl: "https://secret.example.com" });
		const url = client.buildShareUrl("aBcDeFgHiJkL", "myKeyFragment");
		expect(url).toBe("https://secret.example.com/note/aBcDeFgHiJkL#myKeyFragment");
	});

	test("parseShareUrl extracts id and keyFragment", () => {
		const result = SecretClient.parseShareUrl("https://secret.example.com/note/aBcDeFgHiJkL#myKey");
		expect(result.id).toBe("aBcDeFgHiJkL");
		expect(result.keyFragment).toBe("myKey");
	});

	test("parseShareUrl throws on invalid URL", () => {
		expect(() => SecretClient.parseShareUrl("https://example.com/other")).toThrow(
			"missing note ID",
		);
		expect(() => SecretClient.parseShareUrl("https://example.com/note/abc")).toThrow(
			"missing key fragment",
		);
	});

	test("createNote with text-only sends postJson", async () => {
		const http = await getHttpMocks();
		http.postJson.mockResolvedValue({
			id: "note123456ab",
			expiresAt: "2099-01-01T00:00:00Z",
			deleteToken: "del-tok-123",
		});

		const client = await SecretClient.create({ baseUrl: "https://example.com" });
		const result = await client.createNote({ text: "Hello world", contentMode: "text" });

		expect(result.id).toBe("note123456ab");
		expect(result.expiresAt).toBe("2099-01-01T00:00:00Z");
		expect(result.deleteToken).toBe("del-tok-123");
		expect(result.keyFragment).toBe("base64urlKey");

		expect(http.postJson).toHaveBeenCalledOnce();
		const body = http.postJson.mock.calls[0]?.[2] as Record<string, unknown>;
		expect(body["encryptedData"]).toBe("base64EncData");
		expect(body["clientNonce"]).toBe("base64Nonce");
		expect(body["hasPassword"]).toBe(false);
		expect(body["fileCount"]).toBe(0);
		expect(body["maxReads"]).toBe(1);
		expect(body["expiresIn"]).toBe(86400);
	});

	test("createNote with custom expiresIn and maxReads", async () => {
		const http = await getHttpMocks();
		http.postJson.mockResolvedValue({
			id: "note123456ab",
			expiresAt: "2099-01-01T00:00:00Z",
			deleteToken: "del-tok",
		});

		const client = await SecretClient.create({ baseUrl: "https://example.com" });
		await client.createNote({ text: "test", expiresIn: 3600, maxReads: 5 });

		const body = http.postJson.mock.calls[0]?.[2] as Record<string, unknown>;
		expect(body["expiresIn"]).toBe(3600);
		expect(body["maxReads"]).toBe(5);
	});

	test("createNote with password includes salt", async () => {
		const crypto = await getCryptoMocks();
		crypto.encryptNote.mockResolvedValue({
			encryptedData: "encData",
			clientNonce: "nonce",
			keyFragment: "key",
			salt: "someSalt",
		});

		const http = await getHttpMocks();
		http.postJson.mockResolvedValue({
			id: "note123456ab",
			expiresAt: "2099-01-01",
			deleteToken: "tok",
		});

		const client = await SecretClient.create({ baseUrl: "https://example.com" });
		await client.createNote({ text: "secret", password: "pass123" });

		const body = http.postJson.mock.calls[0]?.[2] as Record<string, unknown>;
		expect(body["hasPassword"]).toBe(true);
		expect(body["salt"]).toBe("someSalt");
	});

	test("createNote with files sends postFormData", async () => {
		const crypto = await getCryptoMocks();
		crypto.encryptNote.mockResolvedValue({
			encryptedData: btoa("encrypted-bytes"),
			clientNonce: "nonce",
			keyFragment: "key",
		});

		const http = await getHttpMocks();
		http.postFormData.mockResolvedValue({
			id: "fileNote12345",
			expiresAt: "2099-01-01",
			deleteToken: "ftok",
		});

		const client = await SecretClient.create({ baseUrl: "https://example.com" });
		const fileData = new TextEncoder().encode("file content");
		const onUploadProgress = vi.fn();

		const result = await client.createNote({
			text: "Note with file",
			files: [{ name: "test.txt", type: "text/plain", data: fileData }],
			onUploadProgress,
		});

		expect(result.id).toBe("fileNote12345");
		expect(http.postFormData).toHaveBeenCalledOnce();

		const callArgs = http.postFormData.mock.calls[0] ?? [];
		expect(callArgs[1]).toBe("/notes/upload");
		const formData = callArgs[2] as FormData;
		expect(formData.get("metadata")).toBeTruthy();
		expect(formData.get("data")).toBeTruthy();

		const metadata = JSON.parse(formData.get("metadata") as string) as Record<string, unknown>;
		expect(metadata["fileCount"]).toBe(1);
		expect(metadata["hasPassword"]).toBe(false);

		expect(callArgs[3]).toBe(onUploadProgress);
	});

	test("createNote with files and password includes salt in metadata", async () => {
		const crypto = await getCryptoMocks();
		crypto.encryptNote.mockResolvedValue({
			encryptedData: btoa("encrypted"),
			clientNonce: "nonce",
			keyFragment: "key",
			salt: "fileSalt",
		});

		const http = await getHttpMocks();
		http.postFormData.mockResolvedValue({
			id: "fileNote12345",
			expiresAt: "2099-01-01",
			deleteToken: "ftok",
		});

		const client = await SecretClient.create({ baseUrl: "https://example.com" });
		const fileData = new TextEncoder().encode("data");

		await client.createNote({
			files: [{ name: "f.bin", type: "application/octet-stream", data: fileData }],
			password: "secret",
		});

		const formData = http.postFormData.mock.calls[0]?.[2] as FormData;
		const metadata = JSON.parse(formData.get("metadata") as string) as Record<string, unknown>;
		expect(metadata["salt"]).toBe("fileSalt");
		expect(metadata["hasPassword"]).toBe(true);
	});

	test("readNote decrypts and returns the note payload via raw endpoint", async () => {
		const http = await getHttpMocks();
		http.getNoteRaw.mockResolvedValue({
			encryptedBytes: new Uint8Array([1, 2, 3]),
			nonceBytes: new Uint8Array([4, 5, 6]),
			hasPassword: false,
			fileCount: 0,
			createdAt: "2024-01-01",
			expiresAt: "2099-01-01",
		});

		const crypto = await getCryptoMocks();
		crypto.decryptNoteBytes.mockResolvedValue({ text: "hello", contentMode: "text" });

		const client = await SecretClient.create({ baseUrl: "https://example.com" });
		const result = await client.readNote("noteId123456", "keyFrag");

		expect(result.payload.text).toBe("hello");
		expect(result.createdAt).toBe("2024-01-01");
		expect(result.expiresAt).toBe("2099-01-01");
		expect(result.fileCount).toBe(0);

		expect(crypto.decryptNoteBytes).toHaveBeenCalledWith(
			new Uint8Array([1, 2, 3]),
			new Uint8Array([4, 5, 6]),
			"keyFrag",
			undefined,
			undefined,
		);
	});

	test("readNote passes password and salt to decryptNoteBytes via raw endpoint", async () => {
		const http = await getHttpMocks();
		http.getNoteRaw.mockResolvedValue({
			encryptedBytes: new Uint8Array([10, 20]),
			nonceBytes: new Uint8Array([30, 40]),
			hasPassword: true,
			fileCount: 0,
			createdAt: "2024-01-01",
			expiresAt: "2099-01-01",
			salt: "someSalt",
		});

		const crypto = await getCryptoMocks();
		crypto.decryptNoteBytes.mockResolvedValue({ text: "secret text" });

		const client = await SecretClient.create({ baseUrl: "https://example.com" });
		const result = await client.readNote("noteId123456", "keyFrag", {
			password: "myPass",
		});

		expect(result.payload.text).toBe("secret text");

		expect(crypto.decryptNoteBytes).toHaveBeenCalledWith(
			new Uint8Array([10, 20]),
			new Uint8Array([30, 40]),
			"keyFrag",
			"myPass",
			"someSalt",
		);
	});

	test("readNote throws SecretDecryptionError on decryption failure (Error instance)", async () => {
		const http = await getHttpMocks();
		http.getNoteRaw.mockResolvedValue({
			encryptedBytes: new Uint8Array([1]),
			nonceBytes: new Uint8Array([2]),
			hasPassword: false,
			fileCount: 0,
			createdAt: "2024-01-01",
			expiresAt: "2099-01-01",
		});

		const crypto = await getCryptoMocks();
		crypto.decryptNoteBytes.mockRejectedValue(new Error("wrong key or corrupted"));

		const client = await SecretClient.create({ baseUrl: "https://example.com" });

		await expect(client.readNote("noteId123456", "badKey")).rejects.toThrow(SecretDecryptionError);
		await expect(client.readNote("noteId123456", "badKey")).rejects.toThrow(
			"wrong key or corrupted",
		);
	});

	test("readNote throws SecretDecryptionError with fallback message on non-Error throw", async () => {
		const http = await getHttpMocks();
		http.getNoteRaw.mockResolvedValue({
			encryptedBytes: new Uint8Array([1]),
			nonceBytes: new Uint8Array([2]),
			hasPassword: false,
			fileCount: 0,
			createdAt: "2024-01-01",
			expiresAt: "2099-01-01",
		});

		const crypto = await getCryptoMocks();
		crypto.decryptNoteBytes.mockRejectedValue("string error");

		const client = await SecretClient.create({ baseUrl: "https://example.com" });

		await expect(client.readNote("noteId123456", "badKey")).rejects.toThrow(SecretDecryptionError);
		await expect(client.readNote("noteId123456", "badKey")).rejects.toThrow("Decryption failed");
	});

	test("readNote falls back to legacy JSON endpoint when raw returns 404", async () => {
		const http = await getHttpMocks();
		http.getNoteRaw.mockRejectedValue(new SecretApiError("Not found", 404));
		http.getNote.mockResolvedValue({
			encryptedData: "legacyEnc",
			clientNonce: "legacyNonce",
			hasPassword: false,
			fileCount: 0,
			createdAt: "2024-01-01",
			expiresAt: "2099-01-01",
		});

		const crypto = await getCryptoMocks();
		crypto.decryptNote.mockResolvedValue({ text: "legacy text", contentMode: "text" });

		const client = await SecretClient.create({ baseUrl: "https://example.com" });
		const result = await client.readNote("noteId123456", "keyFrag");

		expect(result.payload.text).toBe("legacy text");
		expect(http.getNoteRaw).toHaveBeenCalled();
		expect(http.getNote).toHaveBeenCalled();
	});

	test("readNote does NOT fall back when raw returns SecretDecryptionError", async () => {
		const http = await getHttpMocks();
		http.getNoteRaw.mockResolvedValue({
			encryptedBytes: new Uint8Array([1, 2, 3]),
			nonceBytes: new Uint8Array([4, 5, 6]),
			hasPassword: false,
			fileCount: 0,
			createdAt: "2024-01-01",
			expiresAt: "2099-01-01",
		});

		const crypto = await getCryptoMocks();
		crypto.decryptNoteBytes.mockRejectedValue(new Error("bad key"));

		const client = await SecretClient.create({ baseUrl: "https://example.com" });

		await expect(client.readNote("noteId123456", "badKey")).rejects.toThrow(SecretDecryptionError);
		expect(http.getNote).not.toHaveBeenCalled();
	});

	test("readNote with onProgress fires downloading and decrypting phases", async () => {
		const http = await getHttpMocks();
		http.getNoteRaw.mockImplementation(
			async (_config: unknown, _id: unknown, onProgress?: (p: number) => void) => {
				onProgress?.(0.5);
				onProgress?.(1);
				return {
					encryptedBytes: new Uint8Array([1]),
					nonceBytes: new Uint8Array([2]),
					hasPassword: false,
					fileCount: 0,
					createdAt: "2024-01-01",
					expiresAt: "2099-01-01",
				};
			},
		);

		const crypto = await getCryptoMocks();
		crypto.decryptNoteBytes.mockResolvedValue({
			text: "progress text",
			contentMode: "text",
		});

		const onProgress = vi.fn();
		const client = await SecretClient.create({ baseUrl: "https://example.com" });
		await client.readNote("noteId123456", "keyFrag", { onProgress });

		const phases = onProgress.mock.calls.map((call: Array<{ phase: string }>) => call[0]?.phase);
		expect(phases).toContain("downloading");
		expect(phases).toContain("decrypting");
	});

	test("readNote legacy path throws SecretDecryptionError on decryption failure", async () => {
		const http = await getHttpMocks();
		http.getNoteRaw.mockRejectedValue(new SecretApiError("Not found", 404));
		http.getNote.mockResolvedValue({
			encryptedData: "badData",
			clientNonce: "nonce",
			hasPassword: false,
			fileCount: 0,
			createdAt: "2024-01-01",
			expiresAt: "2099-01-01",
		});

		const crypto = await getCryptoMocks();
		crypto.decryptNote.mockRejectedValue(new Error("legacy decrypt failed"));

		const client = await SecretClient.create({ baseUrl: "https://example.com" });

		await expect(client.readNote("noteId123456", "badKey")).rejects.toThrow(SecretDecryptionError);
		await expect(client.readNote("noteId123456", "badKey")).rejects.toThrow(
			"legacy decrypt failed",
		);
	});

	test("readNote legacy path throws SecretDecryptionError with fallback on non-Error throw", async () => {
		const http = await getHttpMocks();
		http.getNoteRaw.mockRejectedValue(new SecretApiError("Not found", 404));
		http.getNote.mockResolvedValue({
			encryptedData: "badData",
			clientNonce: "nonce",
			hasPassword: false,
			fileCount: 0,
			createdAt: "2024-01-01",
			expiresAt: "2099-01-01",
		});

		const crypto = await getCryptoMocks();
		crypto.decryptNote.mockRejectedValue("non-error value");

		const client = await SecretClient.create({ baseUrl: "https://example.com" });

		await expect(client.readNote("noteId123456", "badKey")).rejects.toThrow(SecretDecryptionError);
		await expect(client.readNote("noteId123456", "badKey")).rejects.toThrow("Decryption failed");
	});
});

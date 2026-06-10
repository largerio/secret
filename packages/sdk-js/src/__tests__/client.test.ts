import { beforeEach, describe, expect, test, vi } from "vitest";
import { SecretClient } from "../client.js";
import { SecretApiError, SecretDecryptionError, SecretValidationError } from "../errors.js";

// The single, cause-hiding message every decryption failure must surface.
const UNIFORM_DECRYPTION_MESSAGE = "Unable to decrypt: wrong password/key or corrupted data";

vi.mock("../http.js", () => ({
	postJson: vi.fn(),
	postFormData: vi.fn(),
	getNote: vi.fn(),
	getNoteRaw: vi.fn(),
	getNoteStream: vi.fn(),
	checkNote: vi.fn(),
	deleteNote: vi.fn(),
	initChunkedUpload: vi.fn(),
	uploadChunk: vi.fn(),
	completeChunkedUpload: vi.fn(),
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
	encryptNoteChunked: vi.fn(() =>
		Promise.resolve({
			header: "streamHeaderB64",
			chunks: [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])],
			keyFragment: "chunkedKeyFrag",
		}),
	),
	decryptNote: vi.fn(() => Promise.resolve({ text: "decrypted text", contentMode: "text" })),
	decryptNoteBytes: vi.fn(() =>
		Promise.resolve({ text: "decrypted raw text", contentMode: "text" }),
	),
	decryptNoteChunked: vi.fn(() =>
		Promise.resolve({ text: "decrypted chunked text", contentMode: "text" }),
	),
}));

async function getHttpMocks() {
	return (await import("../http.js")) as typeof import("../http.js") & {
		postJson: ReturnType<typeof vi.fn>;
		postFormData: ReturnType<typeof vi.fn>;
		getNote: ReturnType<typeof vi.fn>;
		getNoteRaw: ReturnType<typeof vi.fn>;
		getNoteStream: ReturnType<typeof vi.fn>;
		checkNote: ReturnType<typeof vi.fn>;
		deleteNote: ReturnType<typeof vi.fn>;
		initChunkedUpload: ReturnType<typeof vi.fn>;
		uploadChunk: ReturnType<typeof vi.fn>;
		completeChunkedUpload: ReturnType<typeof vi.fn>;
	};
}

async function getCryptoMocks() {
	return (await import("../crypto.js")) as typeof import("../crypto.js") & {
		encryptNote: ReturnType<typeof vi.fn>;
		encryptNoteChunked: ReturnType<typeof vi.fn>;
		decryptNote: ReturnType<typeof vi.fn>;
		decryptNoteBytes: ReturnType<typeof vi.fn>;
		decryptNoteChunked: ReturnType<typeof vi.fn>;
	};
}

describe("SecretClient", () => {
	beforeEach(async () => {
		const http = await getHttpMocks();
		http.postJson.mockReset();
		http.postFormData.mockReset();
		http.getNote.mockReset();
		http.getNoteRaw.mockReset();
		http.getNoteStream.mockReset();
		http.checkNote.mockReset();
		http.deleteNote.mockReset();
		http.initChunkedUpload.mockReset();
		http.uploadChunk.mockReset();
		http.completeChunkedUpload.mockReset();

		// Default: stream endpoint rejects with 400 so tests fall through to raw/legacy
		http.getNoteStream.mockRejectedValue(new SecretApiError("Not a chunked note", 400));

		const crypto = await getCryptoMocks();
		crypto.encryptNote.mockReset();
		crypto.encryptNote.mockResolvedValue({
			encryptedData: "base64EncData",
			clientNonce: "base64Nonce",
			keyFragment: "base64urlKey",
		});
		crypto.encryptNoteChunked.mockReset();
		crypto.encryptNoteChunked.mockResolvedValue({
			header: "streamHeaderB64",
			chunks: [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])],
			keyFragment: "chunkedKeyFrag",
		});
		crypto.decryptNote.mockReset();
		crypto.decryptNoteBytes.mockReset();
		crypto.decryptNoteBytes.mockResolvedValue({
			text: "decrypted raw text",
			contentMode: "text",
		});
		crypto.decryptNoteChunked.mockReset();
		crypto.decryptNoteChunked.mockResolvedValue({
			text: "decrypted chunked text",
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

	test("passes timeout and retry options through to httpConfig", async () => {
		const http = await getHttpMocks();
		http.checkNote.mockResolvedValue({
			exists: false,
			hasPassword: false,
			fileCount: 0,
			expiresAt: "",
			maxReads: 1,
			chunked: false,
		});

		const backoff = (attempt: number): number => attempt * 100;
		const client = await SecretClient.create({
			baseUrl: "https://example.com",
			timeoutMs: 5000,
			maxRetries: 4,
			retryBackoffMs: backoff,
		});

		await client.checkNote("aBcDeFgHiJkL");

		const config = http.checkNote.mock.calls[0]?.[0] as import("../http.js").HttpClientConfig;
		expect(config.timeoutMs).toBe(5000);
		expect(config.maxRetries).toBe(4);
		expect(config.retryBackoffMs).toBe(backoff);
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

	test("createNote rejects oversized text before any network call", async () => {
		const http = await getHttpMocks();
		const client = await SecretClient.create({ baseUrl: "https://example.com" });

		await expect(client.createNote({ text: "x".repeat(102_401) })).rejects.toThrow(
			SecretValidationError,
		);
		expect(http.postJson).not.toHaveBeenCalled();
		expect(http.postFormData).not.toHaveBeenCalled();
		expect(http.initChunkedUpload).not.toHaveBeenCalled();
	});

	test("createNote rejects too many files before any network call", async () => {
		const http = await getHttpMocks();
		const client = await SecretClient.create({ baseUrl: "https://example.com" });

		const files = Array.from({ length: 11 }, (_, i) => ({
			name: `f${String(i)}.bin`,
			type: "application/octet-stream",
			data: new Uint8Array([1]),
		}));
		await expect(client.createNote({ files })).rejects.toThrow(SecretValidationError);
		expect(http.postJson).not.toHaveBeenCalled();
		expect(http.postFormData).not.toHaveBeenCalled();
		expect(http.initChunkedUpload).not.toHaveBeenCalled();
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

		// The upload callback is now wrapped to also drive the overall-progress
		// bar, but it must still forward the raw 0–1 value to onUploadProgress.
		const forwarded = callArgs[3] as (p: number) => void;
		expect(typeof forwarded).toBe("function");
		forwarded(0.5);
		expect(onUploadProgress).toHaveBeenCalledWith(0.5);
	});

	test("createNote file upload maps byte progress onto the overall bar", async () => {
		const crypto = await getCryptoMocks();
		crypto.encryptNote.mockResolvedValue({
			encryptedData: btoa("encrypted-bytes"),
			clientNonce: "nonce",
			keyFragment: "key",
		});

		const http = await getHttpMocks();
		http.postFormData.mockResolvedValue({
			id: "fileNote99999",
			expiresAt: "2099-01-01T00:00:00Z",
			deleteToken: "ftok",
		});

		const client = await SecretClient.create({ baseUrl: "https://example.com" });
		const onProgress = vi.fn();

		await client.createNote({
			text: "Note with file",
			files: [{ name: "t.txt", type: "text/plain", data: new TextEncoder().encode("x") }],
			onProgress,
		});

		const forwarded = (http.postFormData.mock.calls[0] ?? [])[3] as (p: number) => void;
		forwarded(0.5);
		// Upload spans the bar from the post-encryption milestone (0.3) to 1.
		expect(onProgress).toHaveBeenCalledWith({
			phase: "uploading",
			phaseProgress: 0.5,
			overallProgress: 0.3 + 0.5 * 0.7,
		});
	});

	test("createNote file upload without progress callbacks omits the wrapper", async () => {
		const crypto = await getCryptoMocks();
		crypto.encryptNote.mockResolvedValue({
			encryptedData: btoa("encrypted-bytes"),
			clientNonce: "nonce",
			keyFragment: "key",
		});

		const http = await getHttpMocks();
		http.postFormData.mockResolvedValue({
			id: "fileNoteABCDE",
			expiresAt: "2099-01-01T00:00:00Z",
			deleteToken: "ftok",
		});

		const client = await SecretClient.create({ baseUrl: "https://example.com" });
		await client.createNote({
			text: "Note with file",
			files: [{ name: "t.txt", type: "text/plain", data: new TextEncoder().encode("x") }],
		});

		expect((http.postFormData.mock.calls[0] ?? [])[3]).toBeUndefined();
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

	test("readNote throws a uniform SecretDecryptionError that hides the cause (Error instance)", async () => {
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
		// The underlying crypto message must NOT leak to the caller.
		const err = await client.readNote("noteId123456", "badKey").catch((e) => e);
		expect(err).toBeInstanceOf(SecretDecryptionError);
		expect(err.message).toBe(UNIFORM_DECRYPTION_MESSAGE);
		expect(err.message).not.toContain("wrong key or corrupted");
	});

	test("readNote uses the same uniform error on a non-Error throw", async () => {
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
		await expect(client.readNote("noteId123456", "badKey")).rejects.toThrow(
			UNIFORM_DECRYPTION_MESSAGE,
		);
	});

	test("wrong key and tampered ciphertext are indistinguishable to the caller", async () => {
		const http = await getHttpMocks();
		const crypto = await getCryptoMocks();
		const rawResponse = {
			encryptedBytes: new Uint8Array([1]),
			nonceBytes: new Uint8Array([2]),
			hasPassword: true,
			fileCount: 0,
			createdAt: "2024-01-01",
			expiresAt: "2099-01-01",
			salt: "someSalt",
		};
		const client = await SecretClient.create({ baseUrl: "https://example.com" });

		// Scenario A: wrong password/key — libsodium reports an auth failure.
		http.getNoteRaw.mockResolvedValue(rawResponse);
		crypto.decryptNoteBytes.mockRejectedValue(
			new Error("incorrect key pair for the given ciphertext"),
		);
		const wrongKeyErr = await client
			.readNote("noteId123456", "badKey", { password: "nope" })
			.catch((e) => e);

		// Scenario B: corrupted/tampered ciphertext — a different underlying error.
		crypto.decryptNoteBytes.mockRejectedValue(new Error("invalid ciphertext: message forged"));
		const tamperedErr = await client
			.readNote("noteId123456", "rightKey", { password: "correct" })
			.catch((e) => e);

		expect(wrongKeyErr).toBeInstanceOf(SecretDecryptionError);
		expect(tamperedErr).toBeInstanceOf(SecretDecryptionError);
		// Same type AND same message: the caller cannot tell the two apart.
		expect(wrongKeyErr.message).toBe(tamperedErr.message);
		expect(wrongKeyErr.message).toBe(UNIFORM_DECRYPTION_MESSAGE);
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
			UNIFORM_DECRYPTION_MESSAGE,
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
		await expect(client.readNote("noteId123456", "badKey")).rejects.toThrow(
			UNIFORM_DECRYPTION_MESSAGE,
		);
	});

	// --- Chunked upload (createNoteChunked) tests ---

	test("createNote with chunked: true uses chunked upload flow", async () => {
		const http = await getHttpMocks();
		http.initChunkedUpload.mockResolvedValue({
			uploadId: "upload-abc",
			expiresAt: "2099-01-01T00:00:00Z",
		});
		http.uploadChunk.mockResolvedValue(undefined);
		http.completeChunkedUpload.mockResolvedValue({
			id: "chunkedNote123",
			expiresAt: "2099-01-01T00:00:00Z",
			deleteToken: "del-chunked",
		});

		const client = await SecretClient.create({ baseUrl: "https://example.com" });
		const result = await client.createNote({ text: "chunked text", chunked: true });

		expect(result.id).toBe("chunkedNote123");
		expect(result.deleteToken).toBe("del-chunked");
		expect(result.keyFragment).toBe("chunkedKeyFrag");

		expect(http.initChunkedUpload).toHaveBeenCalledOnce();
		const initMeta = http.initChunkedUpload.mock.calls[0]?.[1] as Record<string, unknown>;
		expect(initMeta["streamHeader"]).toBe("streamHeaderB64");
		expect(initMeta["chunkCount"]).toBe(2);
		expect(initMeta["hasPassword"]).toBe(false);
		expect(initMeta["fileCount"]).toBe(0);

		// Two chunks uploaded
		expect(http.uploadChunk).toHaveBeenCalledTimes(2);
		expect(http.completeChunkedUpload).toHaveBeenCalledOnce();
	});

	test("createNote auto-selects chunked when payload exceeds chunkSize", async () => {
		const http = await getHttpMocks();
		http.initChunkedUpload.mockResolvedValue({
			uploadId: "upload-auto",
			expiresAt: "2099-01-01T00:00:00Z",
		});
		http.uploadChunk.mockResolvedValue(undefined);
		http.completeChunkedUpload.mockResolvedValue({
			id: "autoChunked12",
			expiresAt: "2099-01-01T00:00:00Z",
			deleteToken: "del-auto",
		});

		const client = await SecretClient.create({ baseUrl: "https://example.com" });
		// Use a very small chunkSize so the text payload exceeds it
		const result = await client.createNote({
			text: "x".repeat(100),
			chunkSize: 10,
		});

		expect(result.id).toBe("autoChunked12");
		expect(http.initChunkedUpload).toHaveBeenCalledOnce();
	});

	test("createNote chunked with password includes salt in metadata", async () => {
		const crypto = await getCryptoMocks();
		crypto.encryptNoteChunked.mockResolvedValue({
			header: "headerB64",
			chunks: [new Uint8Array([7, 8])],
			keyFragment: "pwKey",
			salt: "chunkedSalt",
		});

		const http = await getHttpMocks();
		http.initChunkedUpload.mockResolvedValue({
			uploadId: "upload-pw",
			expiresAt: "2099-01-01T00:00:00Z",
		});
		http.uploadChunk.mockResolvedValue(undefined);
		http.completeChunkedUpload.mockResolvedValue({
			id: "pwChunked1234",
			expiresAt: "2099-01-01T00:00:00Z",
			deleteToken: "del-pw",
		});

		const client = await SecretClient.create({ baseUrl: "https://example.com" });
		await client.createNote({ text: "secret", password: "pass", chunked: true });

		const initMeta = http.initChunkedUpload.mock.calls[0]?.[1] as Record<string, unknown>;
		expect(initMeta["salt"]).toBe("chunkedSalt");
		expect(initMeta["hasPassword"]).toBe(true);
	});

	test("createNote chunked with files passes correct fileCount", async () => {
		const http = await getHttpMocks();
		http.initChunkedUpload.mockResolvedValue({
			uploadId: "upload-f",
			expiresAt: "2099-01-01",
		});
		http.uploadChunk.mockResolvedValue(undefined);
		http.completeChunkedUpload.mockResolvedValue({
			id: "fileChunked12",
			expiresAt: "2099-01-01",
			deleteToken: "del-f",
		});

		const client = await SecretClient.create({ baseUrl: "https://example.com" });
		const fileData = new Uint8Array([1, 2, 3]);
		await client.createNote({
			files: [{ name: "f.bin", type: "application/octet-stream", data: fileData }],
			chunked: true,
		});

		const initMeta = http.initChunkedUpload.mock.calls[0]?.[1] as Record<string, unknown>;
		expect(initMeta["fileCount"]).toBe(1);
	});

	test("createNote chunked fires onProgress and onUploadProgress callbacks", async () => {
		const http = await getHttpMocks();
		http.initChunkedUpload.mockResolvedValue({
			uploadId: "upload-prog",
			expiresAt: "2099-01-01",
		});
		http.uploadChunk.mockResolvedValue(undefined);
		http.completeChunkedUpload.mockResolvedValue({
			id: "progNote12345",
			expiresAt: "2099-01-01",
			deleteToken: "del-prog",
		});

		const onProgress = vi.fn();
		const onUploadProgress = vi.fn();

		const client = await SecretClient.create({ baseUrl: "https://example.com" });
		await client.createNote({
			text: "progress test",
			chunked: true,
			onProgress,
			onUploadProgress,
		});

		// onProgress should have encrypting, uploading, and processing phases
		const phases = onProgress.mock.calls.map((call: Array<{ phase: string }>) => call[0]?.phase);
		expect(phases).toContain("encrypting");
		expect(phases).toContain("uploading");
		expect(phases).toContain("processing");

		// onUploadProgress called once per chunk (2 chunks)
		expect(onUploadProgress).toHaveBeenCalledTimes(2);
		expect(onUploadProgress).toHaveBeenNthCalledWith(1, 0.5);
		expect(onUploadProgress).toHaveBeenNthCalledWith(2, 1);

		// Check chunk info in uploading progress calls
		const uploadCalls = onProgress.mock.calls.filter(
			(call: Array<{ phase: string; currentChunk?: number }>) =>
				call[0]?.phase === "uploading" && call[0]?.currentChunk !== undefined,
		);
		expect(uploadCalls.length).toBeGreaterThanOrEqual(2);
	});

	test("createNote chunked passes capToken to init and complete", async () => {
		const http = await getHttpMocks();
		http.initChunkedUpload.mockResolvedValue({
			uploadId: "upload-cap",
			expiresAt: "2099-01-01",
		});
		http.uploadChunk.mockResolvedValue(undefined);
		http.completeChunkedUpload.mockResolvedValue({
			id: "capNote123456",
			expiresAt: "2099-01-01",
			deleteToken: "del-cap",
		});

		const client = await SecretClient.create({ baseUrl: "https://example.com" });
		await client.createNote({
			text: "cap test",
			chunked: true,
			capToken: "my-cap-token",
		});

		// capToken passed to initChunkedUpload
		expect(http.initChunkedUpload.mock.calls[0]?.[2]).toBe("my-cap-token");
		// capToken passed to completeChunkedUpload
		expect(http.completeChunkedUpload.mock.calls[0]?.[2]).toBe("my-cap-token");
	});

	test("createNote chunked passes custom expiresIn and maxReads", async () => {
		const http = await getHttpMocks();
		http.initChunkedUpload.mockResolvedValue({
			uploadId: "upload-opts",
			expiresAt: "2099-01-01",
		});
		http.uploadChunk.mockResolvedValue(undefined);
		http.completeChunkedUpload.mockResolvedValue({
			id: "optsNote12345",
			expiresAt: "2099-01-01",
			deleteToken: "del-opts",
		});

		const client = await SecretClient.create({ baseUrl: "https://example.com" });
		await client.createNote({
			text: "opts test",
			chunked: true,
			expiresIn: 7200,
			maxReads: 10,
		});

		const initMeta = http.initChunkedUpload.mock.calls[0]?.[1] as Record<string, unknown>;
		expect(initMeta["expiresIn"]).toBe(7200);
		expect(initMeta["maxReads"]).toBe(10);
	});

	// --- chunked hint tests ---

	test("readNote with chunked: true goes directly to stream endpoint", async () => {
		const http = await getHttpMocks();
		http.getNoteStream.mockResolvedValue({
			streamHeader: "headerB64",
			chunkCount: 1,
			hasPassword: false,
			fileCount: 0,
			createdAt: "2024-06-01",
			expiresAt: "2099-06-01",
			chunks: [new Uint8Array([10])],
		});

		const client = await SecretClient.create({ baseUrl: "https://example.com" });
		await client.readNote("streamNote123", "keyFrag", { chunked: true });

		expect(http.getNoteStream).toHaveBeenCalled();
		expect(http.getNoteRaw).not.toHaveBeenCalled();
		expect(http.getNote).not.toHaveBeenCalled();
	});

	test("readNote with chunked: false skips stream and uses raw endpoint", async () => {
		const http = await getHttpMocks();
		http.getNoteRaw.mockResolvedValue({
			data: new Uint8Array([1, 2, 3]),
			clientNonce: "nonce",
			hasPassword: false,
			fileCount: 0,
			createdAt: "2024-06-01",
			expiresAt: "2099-06-01",
		});

		const client = await SecretClient.create({ baseUrl: "https://example.com" });
		await client.readNote("rawNote1234567", "keyFrag", { chunked: false });

		expect(http.getNoteStream).not.toHaveBeenCalled();
		expect(http.getNoteRaw).toHaveBeenCalled();
	});

	// --- Stream read (readNoteStream) tests ---

	test("readNote uses stream endpoint when it succeeds", async () => {
		const http = await getHttpMocks();
		http.getNoteStream.mockResolvedValue({
			streamHeader: "headerB64",
			chunkCount: 2,
			hasPassword: false,
			fileCount: 0,
			createdAt: "2024-06-01",
			expiresAt: "2099-06-01",
			chunks: [new Uint8Array([10]), new Uint8Array([20])],
		});

		const client = await SecretClient.create({ baseUrl: "https://example.com" });
		const result = await client.readNote("streamNote123", "keyFrag");

		expect(result.payload.text).toBe("decrypted chunked text");
		expect(result.createdAt).toBe("2024-06-01");
		expect(result.expiresAt).toBe("2099-06-01");
		expect(result.fileCount).toBe(0);

		expect(http.getNoteStream).toHaveBeenCalled();
		// raw and legacy should NOT be called
		expect(http.getNoteRaw).not.toHaveBeenCalled();
		expect(http.getNote).not.toHaveBeenCalled();
	});

	test("readNote stream path passes password and salt to decryptNoteChunked", async () => {
		const http = await getHttpMocks();
		http.getNoteStream.mockResolvedValue({
			streamHeader: "headerB64",
			chunkCount: 1,
			hasPassword: true,
			fileCount: 0,
			createdAt: "2024-01-01",
			expiresAt: "2099-01-01",
			salt: "streamSalt",
			chunks: [new Uint8Array([1])],
		});

		const crypto = await getCryptoMocks();
		const client = await SecretClient.create({ baseUrl: "https://example.com" });
		await client.readNote("streamNote123", "keyFrag", { password: "myPass" });

		expect(crypto.decryptNoteChunked).toHaveBeenCalledWith(
			[new Uint8Array([1])],
			"headerB64",
			"keyFrag",
			"myPass",
			"streamSalt",
		);
	});

	test("readNote stream path throws SecretDecryptionError on decrypt failure (Error)", async () => {
		const http = await getHttpMocks();
		http.getNoteStream.mockResolvedValue({
			streamHeader: "headerB64",
			chunkCount: 1,
			hasPassword: false,
			fileCount: 0,
			createdAt: "2024-01-01",
			expiresAt: "2099-01-01",
			chunks: [new Uint8Array([1])],
		});

		const crypto = await getCryptoMocks();
		crypto.decryptNoteChunked.mockRejectedValue(new Error("stream decrypt failed"));

		const client = await SecretClient.create({ baseUrl: "https://example.com" });

		await expect(client.readNote("noteId123456", "badKey")).rejects.toThrow(SecretDecryptionError);
		await expect(client.readNote("noteId123456", "badKey")).rejects.toThrow(
			UNIFORM_DECRYPTION_MESSAGE,
		);
	});

	test("readNote stream path throws SecretDecryptionError with fallback on non-Error", async () => {
		const http = await getHttpMocks();
		http.getNoteStream.mockResolvedValue({
			streamHeader: "headerB64",
			chunkCount: 1,
			hasPassword: false,
			fileCount: 0,
			createdAt: "2024-01-01",
			expiresAt: "2099-01-01",
			chunks: [new Uint8Array([1])],
		});

		const crypto = await getCryptoMocks();
		crypto.decryptNoteChunked.mockRejectedValue("non-error value");

		const client = await SecretClient.create({ baseUrl: "https://example.com" });

		await expect(client.readNote("noteId123456", "badKey")).rejects.toThrow(SecretDecryptionError);
		await expect(client.readNote("noteId123456", "badKey")).rejects.toThrow(
			UNIFORM_DECRYPTION_MESSAGE,
		);
	});

	test("readNote stream decryption error does NOT fall back to raw", async () => {
		const http = await getHttpMocks();
		http.getNoteStream.mockResolvedValue({
			streamHeader: "headerB64",
			chunkCount: 1,
			hasPassword: false,
			fileCount: 0,
			createdAt: "2024-01-01",
			expiresAt: "2099-01-01",
			chunks: [new Uint8Array([1])],
		});

		const crypto = await getCryptoMocks();
		crypto.decryptNoteChunked.mockRejectedValue(new Error("bad key"));

		const client = await SecretClient.create({ baseUrl: "https://example.com" });

		await expect(client.readNote("noteId123456", "badKey")).rejects.toThrow(SecretDecryptionError);
		expect(http.getNoteRaw).not.toHaveBeenCalled();
		expect(http.getNote).not.toHaveBeenCalled();
	});

	test("readNote throws on non-400 API error from stream (does not fall through)", async () => {
		const http = await getHttpMocks();
		http.getNoteStream.mockRejectedValue(new SecretApiError("Server error", 500));

		const client = await SecretClient.create({ baseUrl: "https://example.com" });
		await expect(client.readNote("noteId123456", "keyFrag")).rejects.toThrow(SecretApiError);
		expect(http.getNoteRaw).not.toHaveBeenCalled();
	});

	test("readNote throws on network error from stream (does not fall through)", async () => {
		const http = await getHttpMocks();
		http.getNoteStream.mockRejectedValue(new Error("network failure"));

		const client = await SecretClient.create({ baseUrl: "https://example.com" });
		await expect(client.readNote("noteId123456", "keyFrag")).rejects.toThrow("network failure");
		expect(http.getNoteRaw).not.toHaveBeenCalled();
	});

	test("readNote throws on 500 from raw endpoint (does not fall through to legacy)", async () => {
		const http = await getHttpMocks();
		http.getNoteStream.mockRejectedValue(new SecretApiError("Not chunked", 400));
		http.getNoteRaw.mockRejectedValue(new SecretApiError("Internal error", 500));

		const client = await SecretClient.create({ baseUrl: "https://example.com" });
		await expect(client.readNote("noteId123456", "keyFrag")).rejects.toThrow(SecretApiError);
		expect(http.getNote).not.toHaveBeenCalled();
	});

	test("readNote throws on network error from raw endpoint (does not fall through to legacy)", async () => {
		const http = await getHttpMocks();
		http.getNoteStream.mockRejectedValue(new SecretApiError("Not chunked", 400));
		http.getNoteRaw.mockRejectedValue(new Error("connection refused"));

		const client = await SecretClient.create({ baseUrl: "https://example.com" });
		await expect(client.readNote("noteId123456", "keyFrag")).rejects.toThrow("connection refused");
		expect(http.getNote).not.toHaveBeenCalled();
	});

	test("readNote stream path fires download and decrypt progress callbacks", async () => {
		const http = await getHttpMocks();
		http.getNoteStream.mockImplementation(
			async (_config: unknown, _id: unknown, onProgress?: (p: number) => void) => {
				onProgress?.(0.5);
				onProgress?.(1);
				return {
					streamHeader: "headerB64",
					chunkCount: 1,
					hasPassword: false,
					fileCount: 0,
					createdAt: "2024-01-01",
					expiresAt: "2099-01-01",
					chunks: [new Uint8Array([1])],
				};
			},
		);

		const onProgress = vi.fn();
		const onDownloadProgress = vi.fn();

		const client = await SecretClient.create({ baseUrl: "https://example.com" });
		await client.readNote("noteId123456", "keyFrag", { onProgress, onDownloadProgress });

		// onDownloadProgress should be called
		expect(onDownloadProgress).toHaveBeenCalledWith(0.5);
		expect(onDownloadProgress).toHaveBeenCalledWith(1);

		// onProgress should include both downloading and decrypting phases
		const phases = onProgress.mock.calls.map((call: Array<{ phase: string }>) => call[0]?.phase);
		expect(phases).toContain("downloading");
		expect(phases).toContain("decrypting");
	});
});

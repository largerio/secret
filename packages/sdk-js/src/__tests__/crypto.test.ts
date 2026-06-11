import type { NotePayload } from "@largerio/secret-shared";
import { testVectors } from "@largerio/secret-shared";
import { describe, expect, test } from "vitest";
import {
	decryptNote,
	decryptNoteChunked,
	encryptNote,
	encryptNoteChunked,
	ensureInit,
} from "../crypto.js";

describe("SDK crypto", () => {
	test("encrypts and decrypts a text note without password", async () => {
		await ensureInit();

		const encrypted = await encryptNote({ text: "Hello, SDK!", contentMode: "text" });

		expect(encrypted.encryptedData).toBeTruthy();
		expect(encrypted.clientNonce).toBeTruthy();
		expect(encrypted.keyFragment).toBeTruthy();
		expect(encrypted.salt).toBeUndefined();

		const decrypted = await decryptNote(
			encrypted.encryptedData,
			encrypted.clientNonce,
			encrypted.keyFragment,
		);

		expect(decrypted.text).toBe("Hello, SDK!");
		expect(decrypted.contentMode).toBe("text");
	});

	test("encrypts and decrypts a note with password", async () => {
		await ensureInit();

		const encrypted = await encryptNote(
			{ text: "Secret message", contentMode: "secret" },
			"my-password",
		);

		expect(encrypted.salt).toBeTruthy();

		const decrypted = await decryptNote(
			encrypted.encryptedData,
			encrypted.clientNonce,
			encrypted.keyFragment,
			"my-password",
			encrypted.salt,
		);

		expect(decrypted.text).toBe("Secret message");
	});

	test("fails to decrypt with wrong password", async () => {
		await ensureInit();

		const encrypted = await encryptNote({ text: "Secret" }, "correct-password");

		await expect(
			decryptNote(
				encrypted.encryptedData,
				encrypted.clientNonce,
				encrypted.keyFragment,
				"wrong-password",
				encrypted.salt,
			),
		).rejects.toThrow();
	});

	test("encrypts and decrypts a note with files", async () => {
		await ensureInit();

		const fileData = new TextEncoder().encode("file content");
		const encrypted = await encryptNote({
			text: "Note with file",
			files: [{ name: "test.txt", type: "text/plain", size: fileData.length, data: fileData }],
		});

		const decrypted = await decryptNote(
			encrypted.encryptedData,
			encrypted.clientNonce,
			encrypted.keyFragment,
		);

		expect(decrypted.text).toBe("Note with file");
		expect(decrypted.files).toHaveLength(1);
		expect(decrypted.files?.[0]?.name).toBe("test.txt");
	});

	test("encryptNoteChunked and decryptNoteChunked roundtrip without password", async () => {
		await ensureInit();

		const encrypted = await encryptNoteChunked({ text: "chunked hello", contentMode: "text" }, 64);

		expect(encrypted.header).toBeTruthy();
		expect(encrypted.chunks.length).toBeGreaterThan(0);
		expect(encrypted.keyFragment).toBeTruthy();
		expect(encrypted.salt).toBeUndefined();

		const decrypted = await decryptNoteChunked(
			encrypted.chunks,
			encrypted.header,
			encrypted.keyFragment,
		);

		expect(decrypted.text).toBe("chunked hello");
		expect(decrypted.contentMode).toBe("text");
	});

	test("encryptNoteChunked and decryptNoteChunked roundtrip with password", async () => {
		await ensureInit();

		const encrypted = await encryptNoteChunked(
			{ text: "chunked secret", contentMode: "secret" },
			64,
			"my-password",
		);

		expect(encrypted.salt).toBeTruthy();

		const decrypted = await decryptNoteChunked(
			encrypted.chunks,
			encrypted.header,
			encrypted.keyFragment,
			"my-password",
			encrypted.salt,
		);

		expect(decrypted.text).toBe("chunked secret");
	});

	test("decryptNoteChunked fails with wrong password", async () => {
		await ensureInit();

		const encrypted = await encryptNoteChunked({ text: "secret data" }, 64, "correct-password");

		await expect(
			decryptNoteChunked(
				encrypted.chunks,
				encrypted.header,
				encrypted.keyFragment,
				"wrong-password",
				encrypted.salt,
			),
		).rejects.toThrow();
	});

	test("encryptNoteChunked splits large payloads into multiple chunks", async () => {
		await ensureInit();

		const fileData = new Uint8Array(500);
		fileData.fill(42);
		const payload: NotePayload = {
			text: "hello",
			files: [{ name: "big.bin", type: "application/octet-stream", size: 500, data: fileData }],
		};
		const encrypted = await encryptNoteChunked(payload, 64);

		// Header chunk + ceil(500/64) = 8 data chunks = 9 total
		expect(encrypted.chunks.length).toBeGreaterThan(1);

		const decrypted = await decryptNoteChunked(
			encrypted.chunks,
			encrypted.header,
			encrypted.keyFragment,
		);

		expect(decrypted.text).toBe("hello");
		expect(decrypted.files).toHaveLength(1);
		const file = decrypted.files?.[0];
		expect(file?.name).toBe("big.bin");
		expect(file?.size).toBe(500);
		expect(new Uint8Array(file?.data as ArrayLike<number>)).toEqual(fileData);
	});

	test("encryptNoteChunked handles empty payload", async () => {
		await ensureInit();

		const encrypted = await encryptNoteChunked({}, 64);

		expect(encrypted.chunks).toHaveLength(1);

		const decrypted = await decryptNoteChunked(
			encrypted.chunks,
			encrypted.header,
			encrypted.keyFragment,
		);

		expect(decrypted.text).toBeUndefined();
	});

	test("encryptNoteChunked roundtrips payload with files", async () => {
		await ensureInit();

		const fileData = new TextEncoder().encode("file content here");
		const encrypted = await encryptNoteChunked(
			{
				text: "with file",
				files: [{ name: "test.txt", type: "text/plain", size: fileData.length, data: fileData }],
			},
			32,
		);

		const decrypted = await decryptNoteChunked(
			encrypted.chunks,
			encrypted.header,
			encrypted.keyFragment,
		);

		expect(decrypted.text).toBe("with file");
		expect(decrypted.files).toHaveLength(1);
		expect(decrypted.files?.[0]?.name).toBe("test.txt");
	});

	test("decryptNoteChunked throws when given an empty chunks array", async () => {
		await ensureInit();

		const encrypted = await encryptNoteChunked({ text: "dummy" }, 64);

		await expect(decryptNoteChunked([], encrypted.header, encrypted.keyFragment)).rejects.toThrow(
			"No chunks to decrypt",
		);
	});

	test("decryptNoteChunked returns files with empty data for zero-byte files", async () => {
		await ensureInit();

		const payload: NotePayload = {
			text: "note with empty files",
			files: [
				{ name: "empty.txt", type: "text/plain", size: 0, data: new Uint8Array(0) },
				{ name: "empty2.bin", type: "application/octet-stream", size: 0, data: new Uint8Array(0) },
			],
		};

		const encrypted = await encryptNoteChunked(payload, 64);

		// With zero-byte files, only the header chunk is produced
		expect(encrypted.chunks).toHaveLength(1);

		const decrypted = await decryptNoteChunked(
			encrypted.chunks,
			encrypted.header,
			encrypted.keyFragment,
		);

		expect(decrypted.text).toBe("note with empty files");
		expect(decrypted.files).toHaveLength(2);
		expect(decrypted.files?.[0]?.name).toBe("empty.txt");
		expect(decrypted.files?.[0]?.data).toEqual(new Uint8Array(0));
		expect(decrypted.files?.[1]?.name).toBe("empty2.bin");
		expect(decrypted.files?.[1]?.data).toEqual(new Uint8Array(0));
	});

	test("decryptNoteChunked throws when a file's data is shorter than its declared size", async () => {
		await ensureInit();

		// Build a chunked note by hand whose header lies about a file's size
		// (declares 999 bytes but only ships 5). encryptNoteChunked always derives
		// the header size from the real data, so the mismatch must be forged at the
		// stream level to exercise the length-validation guard.
		const { encryptChunk, encodeRaw, generateKey, initStreamEncrypt, keyToBase64Url, toBase64 } =
			await import("@largerio/secret-crypto/client");

		const baseKey = generateKey();
		const { state, header } = initStreamEncrypt(baseKey);
		const headerBytes = encodeRaw({
			files: [{ name: "lies.txt", type: "text/plain", size: 999 }],
		});
		const fileData = new TextEncoder().encode("short");
		const chunks = [encryptChunk(state, headerBytes, false), encryptChunk(state, fileData, true)];

		await expect(
			decryptNoteChunked(chunks, toBase64(header), keyToBase64Url(baseKey)),
		).rejects.toThrow("does not match the declared size");
	});

	test("is compatible with test vectors", async () => {
		await ensureInit();

		for (const v of testVectors.vectors.pipeline) {
			const { fromBase64 } = await import("@largerio/secret-crypto/client");
			const nonce = fromBase64(v.nonce);
			const key = fromBase64(v.key);

			const { decryptPayload } = await import("@largerio/secret-crypto/client");
			const payload = decryptPayload(fromBase64(v.ciphertext), nonce, key);
			expect(payload.text).toBe(v.payload.text);
		}
	});
});

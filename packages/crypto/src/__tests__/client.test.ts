import type { NotePayload } from "@largerio/secret-shared";
import { testVectors } from "@largerio/secret-shared";
import { beforeAll, describe, expect, it } from "vitest";
// Import exclusively through the public barrel entrypoint that the SDK and web
// app consume, so this test exercises the `./client` export surface directly.
import {
	decryptChunk,
	decryptPayload,
	decryptRaw,
	deriveKeyFromPassword,
	encryptChunk,
	encryptPayload,
	encryptRaw,
	fromBase64,
	generateKey,
	generateNonce,
	generateSalt,
	initSodium,
	initStreamDecrypt,
	initStreamEncrypt,
	keyFromBase64Url,
	keyToBase64Url,
	toBase64,
	zeroMemory,
} from "../client.js";

describe("crypto client barrel", () => {
	beforeAll(async () => {
		await initSodium();
	});

	it("round-trips a payload with text and files", () => {
		const key = generateKey();
		const payload: NotePayload = {
			text: "hello world",
			contentMode: "markdown",
			files: [{ name: "a.txt", type: "text/plain", size: 3, data: new Uint8Array([1, 2, 3]) }],
		};

		const { ciphertext, nonce } = encryptPayload(payload, key);
		const decrypted = decryptPayload(ciphertext, nonce, key);

		expect(decrypted.text).toBe("hello world");
		expect(decrypted.contentMode).toBe("markdown");
		expect(decrypted.files).toHaveLength(1);
		expect(decrypted.files?.[0]?.name).toBe("a.txt");
		expect(decrypted.files?.[0]?.data).toEqual(new Uint8Array([1, 2, 3]));
	});

	it("round-trips raw bytes", () => {
		const key = generateKey();
		const data = new Uint8Array([9, 8, 7, 6, 5]);

		const { ciphertext, nonce } = encryptRaw(data, key);

		expect(decryptRaw(ciphertext, nonce, key)).toEqual(data);
	});

	it("rejects tampered ciphertext", () => {
		const key = generateKey();
		const { ciphertext, nonce } = encryptRaw(new Uint8Array([1, 2, 3, 4]), key);

		const tampered = Uint8Array.from(ciphertext);
		tampered[0] = (tampered[0] ?? 0) ^ 0xff;

		expect(() => decryptRaw(tampered, nonce, key)).toThrow();
	});

	it("rejects decryption with the wrong key", () => {
		const key = generateKey();
		const wrongKey = generateKey();
		const { ciphertext, nonce } = encryptRaw(new Uint8Array([1, 2, 3, 4]), key);

		expect(() => decryptRaw(ciphertext, nonce, wrongKey)).toThrow();
	});

	it("uses a fresh nonce and distinct ciphertext for identical input", () => {
		const key = generateKey();
		const payload: NotePayload = { text: "same", contentMode: "text" };

		const first = encryptPayload(payload, key);
		const second = encryptPayload(payload, key);

		expect(first.nonce).not.toEqual(second.nonce);
		expect(first.ciphertext).not.toEqual(second.ciphertext);
	});

	it("round-trips a multi-chunk stream and flags the final chunk", () => {
		const key = generateKey();
		const chunks = [new Uint8Array([1, 1]), new Uint8Array([2, 2]), new Uint8Array([3, 3])];

		const { state: encState, header } = initStreamEncrypt(key);
		const encrypted = chunks.map((chunk, i) =>
			encryptChunk(encState, chunk, i === chunks.length - 1),
		);

		const decState = initStreamDecrypt(header, key);
		const results = encrypted.map((chunk) => decryptChunk(decState, chunk));

		expect(results.map((r) => r.decrypted)).toEqual(chunks);
		expect(results.map((r) => r.isFinal)).toEqual([false, false, true]);
	});

	it("rejects a tampered stream chunk", () => {
		const key = generateKey();
		const { state: encState, header } = initStreamEncrypt(key);
		const encrypted = encryptChunk(encState, new Uint8Array([4, 5, 6]), true);

		const tampered = Uint8Array.from(encrypted);
		tampered[0] = (tampered[0] ?? 0) ^ 0xff;

		const decState = initStreamDecrypt(header, key);
		expect(() => decryptChunk(decState, tampered)).toThrow();
	});

	it("derives the same key from the same password, salt and base key", () => {
		const salt = generateSalt();
		const baseKey = generateKey();

		const a = deriveKeyFromPassword("correct horse", salt, baseKey);
		const b = deriveKeyFromPassword("correct horse", salt, baseKey);

		expect(a).toEqual(b);
	});

	it("round-trips base64 and base64url encodings", () => {
		const key = generateKey();

		expect(keyFromBase64Url(keyToBase64Url(key))).toEqual(key);
		expect(fromBase64(toBase64(key))).toEqual(key);
	});

	it("zeroes a buffer in place", () => {
		const buf = new Uint8Array([1, 2, 3, 4, 5]);
		zeroMemory(buf);
		expect(buf).toEqual(new Uint8Array([0, 0, 0, 0, 0]));
	});

	it("generates nonces of the expected length", () => {
		expect(generateNonce()).toHaveLength(24);
	});

	it("decrypts the canonical xchacha20poly1305 test vectors through the barrel", () => {
		for (const v of testVectors.vectors.xchacha20poly1305) {
			const decrypted = decryptRaw(
				fromBase64(v.ciphertext),
				fromBase64(v.nonce),
				fromBase64(v.key),
			);
			expect(decrypted).toEqual(fromBase64(v.plaintext));
		}
	});

	it("decrypts the canonical pipeline test vectors through the barrel", () => {
		for (const v of testVectors.vectors.pipeline) {
			const payload = decryptPayload(
				fromBase64(v.ciphertext),
				fromBase64(v.nonce),
				fromBase64(v.key),
			);
			expect(payload.text).toBe(v.payload.text);
			expect(payload.contentMode).toBe(v.payload.contentMode);
		}
	});
});

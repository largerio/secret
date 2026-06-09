import type { NotePayload } from "@largerio/secret-shared";
import { encode } from "@msgpack/msgpack";
import sodium from "libsodium-wrappers-sumo";
import { beforeAll, describe, expect, it } from "vitest";
import {
	decodePayloadBytes,
	decryptChunk,
	decryptPayload,
	decryptRaw,
	initStreamDecrypt,
} from "../decrypt.js";
import {
	encodePayload,
	encodeRaw,
	encryptChunk,
	encryptPayload,
	encryptRaw,
	initStreamEncrypt,
	SECRETSTREAM_ABYTES,
	SECRETSTREAM_HEADERBYTES,
} from "../encrypt.js";
import { generateKey, generateNonce, initSodium } from "../keys.js";

beforeAll(async () => {
	await initSodium();
});

describe("encryptPayload / decryptPayload", () => {
	it("roundtrips a text-only payload", () => {
		const key = generateKey();
		const payload: NotePayload = { text: "Hello, world!" };
		const { ciphertext, nonce } = encryptPayload(payload, key);
		const decrypted = decryptPayload(ciphertext, nonce, key);
		expect(decrypted.text).toBe("Hello, world!");
		expect(decrypted.files).toBeUndefined();
	});

	it("roundtrips a payload with files", () => {
		const key = generateKey();
		const payload: NotePayload = {
			text: "Note with attachment",
			files: [
				{
					name: "test.txt",
					type: "text/plain",
					size: 5,
					data: new Uint8Array([72, 101, 108, 108, 111]),
				},
			],
		};
		const { ciphertext, nonce } = encryptPayload(payload, key);
		const decrypted = decryptPayload(ciphertext, nonce, key);
		expect(decrypted.text).toBe("Note with attachment");
		expect(decrypted.files).toHaveLength(1);
		const file = decrypted.files?.[0];
		expect(file?.name).toBe("test.txt");
		expect(file?.type).toBe("text/plain");
		expect(file?.size).toBe(5);
		expect(new Uint8Array(file?.data as ArrayLike<number>)).toEqual(
			new Uint8Array([72, 101, 108, 108, 111]),
		);
	});

	it("roundtrips a payload with multiple files", () => {
		const key = generateKey();
		const payload: NotePayload = {
			files: [
				{ name: "a.txt", type: "text/plain", size: 1, data: new Uint8Array([65]) },
				{ name: "b.txt", type: "text/plain", size: 1, data: new Uint8Array([66]) },
			],
		};
		const { ciphertext, nonce } = encryptPayload(payload, key);
		const decrypted = decryptPayload(ciphertext, nonce, key);
		expect(decrypted.files).toHaveLength(2);
	});

	it("fails decryption with wrong key", () => {
		const key1 = generateKey();
		const key2 = generateKey();
		const payload: NotePayload = { text: "secret" };
		const { ciphertext, nonce } = encryptPayload(payload, key1);
		expect(() => decryptPayload(ciphertext, nonce, key2)).toThrow();
	});

	it("throws when decoded payload has invalid structure", () => {
		const key = generateKey();
		// Encode a value that has text as a number (invalid for NotePayload)
		const invalidPayload = encode({ text: 12345 });
		const nonce = generateNonce();
		const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
			invalidPayload,
			null,
			null,
			nonce,
			key,
		);
		expect(() => decryptPayload(ciphertext, nonce, key)).toThrow("Decryption failed");
	});

	it("throws when decoded payload has files as non-array", () => {
		const key = generateKey();
		const invalidPayload = encode({ files: "not-an-array" });
		const nonce = generateNonce();
		const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
			invalidPayload,
			null,
			null,
			nonce,
			key,
		);
		expect(() => decryptPayload(ciphertext, nonce, key)).toThrow("Decryption failed");
	});

	it("throws when decoded value is not an object", () => {
		const key = generateKey();
		const invalidPayload = encode("just a string");
		const nonce = generateNonce();
		const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
			invalidPayload,
			null,
			null,
			nonce,
			key,
		);
		expect(() => decryptPayload(ciphertext, nonce, key)).toThrow("Decryption failed");
	});

	it("throws when decoded payload has invalid contentMode", () => {
		const key = generateKey();
		const invalidPayload = encode({ text: "hello", contentMode: "html" });
		const nonce = generateNonce();
		const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
			invalidPayload,
			null,
			null,
			nonce,
			key,
		);
		expect(() => decryptPayload(ciphertext, nonce, key)).toThrow("Decryption failed");
	});

	it("throws when file in payload is null", () => {
		const key = generateKey();
		const invalidPayload = encode({ files: [null] });
		const nonce = generateNonce();
		const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
			invalidPayload,
			null,
			null,
			nonce,
			key,
		);
		expect(() => decryptPayload(ciphertext, nonce, key)).toThrow("Decryption failed");
	});

	it("throws when file in payload has non-string name", () => {
		const key = generateKey();
		const invalidPayload = encode({ files: [{ name: 123, type: "text/plain" }] });
		const nonce = generateNonce();
		const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
			invalidPayload,
			null,
			null,
			nonce,
			key,
		);
		expect(() => decryptPayload(ciphertext, nonce, key)).toThrow("Decryption failed");
	});

	it("throws when file in payload has non-number size", () => {
		const key = generateKey();
		const invalidPayload = encode({
			files: [{ name: "f.txt", type: "text/plain", size: "not-a-number" }],
		});
		const nonce = generateNonce();
		const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
			invalidPayload,
			null,
			null,
			nonce,
			key,
		);
		expect(() => decryptPayload(ciphertext, nonce, key)).toThrow("Decryption failed");
	});

	it("produces different ciphertexts for the same plaintext", () => {
		const key = generateKey();
		const payload: NotePayload = { text: "same" };
		const result1 = encryptPayload(payload, key);
		const result2 = encryptPayload(payload, key);
		expect(result1.ciphertext).not.toEqual(result2.ciphertext);
		expect(result1.nonce).not.toEqual(result2.nonce);
	});
});

describe("encryptRaw / decryptRaw", () => {
	it("roundtrips raw binary data", () => {
		const key = generateKey();
		const data = new Uint8Array([1, 2, 3, 4, 5, 255, 0, 128]);
		const { ciphertext, nonce } = encryptRaw(data, key);
		const decrypted = decryptRaw(ciphertext, nonce, key);
		expect(decrypted).toEqual(data);
	});

	it("fails decryption with wrong key", () => {
		const key1 = generateKey();
		const key2 = generateKey();
		const data = new Uint8Array([42]);
		const { ciphertext, nonce } = encryptRaw(data, key1);
		expect(() => decryptRaw(ciphertext, nonce, key2)).toThrow();
	});

	it("handles empty data", () => {
		const key = generateKey();
		const data = new Uint8Array(0);
		const { ciphertext, nonce } = encryptRaw(data, key);
		const decrypted = decryptRaw(ciphertext, nonce, key);
		expect(decrypted).toEqual(data);
	});
});

describe("secretstream constants", () => {
	it("SECRETSTREAM_ABYTES equals 17", () => {
		expect(SECRETSTREAM_ABYTES).toBe(17);
	});

	it("SECRETSTREAM_HEADERBYTES equals 24", () => {
		expect(SECRETSTREAM_HEADERBYTES).toBe(24);
	});
});

describe("secretstream (chunked encryption)", () => {
	it("roundtrips a single chunk", () => {
		const key = generateKey();
		const data = new Uint8Array([1, 2, 3, 4, 5]);

		const { state: encState, header } = initStreamEncrypt(key);
		const encrypted = encryptChunk(encState, data, true);

		const decState = initStreamDecrypt(header, key);
		const { decrypted, isFinal } = decryptChunk(decState, encrypted);

		expect(decrypted).toEqual(data);
		expect(isFinal).toBe(true);
	});

	it("roundtrips multiple chunks", () => {
		const key = generateKey();
		const chunks = [
			new Uint8Array([10, 20, 30]),
			new Uint8Array([40, 50, 60]),
			new Uint8Array([70, 80, 90]),
		];

		const { state: encState, header } = initStreamEncrypt(key);
		const encrypted = chunks.map((chunk, i) =>
			encryptChunk(encState, chunk, i === chunks.length - 1),
		);

		const decState = initStreamDecrypt(header, key);
		const decrypted = encrypted.map((enc) => decryptChunk(decState, enc));

		expect(decrypted[0]?.decrypted).toEqual(chunks[0]);
		expect(decrypted[0]?.isFinal).toBe(false);
		expect(decrypted[1]?.decrypted).toEqual(chunks[1]);
		expect(decrypted[1]?.isFinal).toBe(false);
		expect(decrypted[2]?.decrypted).toEqual(chunks[2]);
		expect(decrypted[2]?.isFinal).toBe(true);
	});

	it("detects corrupted chunk", () => {
		const key = generateKey();
		const { state: encState, header } = initStreamEncrypt(key);
		const encrypted = encryptChunk(encState, new Uint8Array([1, 2, 3]), true);

		// Corrupt a byte
		const corrupted = new Uint8Array(encrypted);
		corrupted[0] = (corrupted[0] ?? 0) ^ 0xff;

		const decState = initStreamDecrypt(header, key);
		expect(() => decryptChunk(decState, corrupted)).toThrow();
	});

	it("detects truncated chunk", () => {
		const key = generateKey();
		const { state: encState, header } = initStreamEncrypt(key);
		const encrypted = encryptChunk(encState, new Uint8Array([1, 2, 3]), true);

		const truncated = encrypted.slice(0, encrypted.length - 2);

		const decState = initStreamDecrypt(header, key);
		expect(() => decryptChunk(decState, truncated)).toThrow();
	});

	it("fails with wrong key", () => {
		const key1 = generateKey();
		const key2 = generateKey();

		const { state: encState, header } = initStreamEncrypt(key1);
		const encrypted = encryptChunk(encState, new Uint8Array([1, 2, 3]), true);

		// initStreamDecrypt may not throw, but decryptChunk will fail
		const decState = initStreamDecrypt(header, key2);
		expect(() => decryptChunk(decState, encrypted)).toThrow();
	});

	it("each encrypted chunk adds ABYTES overhead", () => {
		const key = generateKey();
		const data = new Uint8Array(100);

		const { state: encState } = initStreamEncrypt(key);
		const encrypted = encryptChunk(encState, data, true);

		expect(encrypted.length).toBe(data.length + SECRETSTREAM_ABYTES);
	});

	it("roundtrips large data split into chunks", () => {
		const key = generateKey();
		const chunkSize = 64;
		const totalSize = 250;
		const original = new Uint8Array(totalSize);
		for (let i = 0; i < totalSize; i++) {
			original[i] = i % 256;
		}

		// Split into chunks
		const inputChunks: Uint8Array[] = [];
		for (let offset = 0; offset < totalSize; offset += chunkSize) {
			inputChunks.push(original.slice(offset, Math.min(offset + chunkSize, totalSize)));
		}

		// Encrypt
		const { state: encState, header } = initStreamEncrypt(key);
		const encryptedChunks = inputChunks.map((chunk, i) =>
			encryptChunk(encState, chunk, i === inputChunks.length - 1),
		);

		// Decrypt
		const decState = initStreamDecrypt(header, key);
		const decryptedParts: Uint8Array[] = [];
		for (const enc of encryptedChunks) {
			const { decrypted } = decryptChunk(decState, enc);
			decryptedParts.push(decrypted);
		}

		// Reassemble
		const reassembled = new Uint8Array(totalSize);
		let offset = 0;
		for (const part of decryptedParts) {
			reassembled.set(part, offset);
			offset += part.length;
		}

		expect(reassembled).toEqual(original);
	});
});

describe("encodePayload / decodePayloadBytes", () => {
	it("roundtrips a text-only payload", () => {
		const payload: NotePayload = { text: "encode-decode test" };
		const encoded = encodePayload(payload);
		const decoded = decodePayloadBytes(encoded);
		expect(decoded.text).toBe("encode-decode test");
	});

	it("roundtrips a payload with files", () => {
		const payload: NotePayload = {
			text: "with files",
			files: [
				{
					name: "f.bin",
					type: "application/octet-stream",
					size: 3,
					data: new Uint8Array([1, 2, 3]),
				},
			],
		};
		const encoded = encodePayload(payload);
		const decoded = decodePayloadBytes(encoded);
		expect(decoded.text).toBe("with files");
		expect(decoded.files).toHaveLength(1);
		expect(decoded.files?.[0]?.name).toBe("f.bin");
	});

	it("throws on invalid payload structure (text as number)", () => {
		const invalid = encode({ text: 999 });
		expect(() => decodePayloadBytes(new Uint8Array(invalid))).toThrow("Decryption failed");
	});

	it("throws on non-object payload", () => {
		const invalid = encode("just a string");
		expect(() => decodePayloadBytes(new Uint8Array(invalid))).toThrow("Decryption failed");
	});
});

describe("encodeRaw", () => {
	it("encodes arbitrary data to msgpack bytes", () => {
		const data = { text: "hello", extra: 42 };
		const encoded = encodeRaw(data);
		expect(encoded).toBeInstanceOf(Uint8Array);
		expect(encoded.length).toBeGreaterThan(0);
	});
});

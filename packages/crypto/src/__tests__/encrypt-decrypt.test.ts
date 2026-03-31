import type { NotePayload } from "@secret/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { decryptPayload, decryptRaw } from "../decrypt.js";
import { encryptPayload, encryptRaw } from "../encrypt.js";
import { generateKey, initSodium } from "../keys.js";

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

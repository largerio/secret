import { testVectors } from "@secret/shared";
import { describe, expect, test } from "vitest";
import { decryptPayload, decryptRaw } from "../decrypt.js";
import {
	deriveKeyFromPassword,
	fromBase64,
	initSodium,
	keyFromBase64Url,
	keyToBase64Url,
} from "../keys.js";

describe("test vectors", () => {
	test("xchacha20poly1305 vectors decrypt correctly", async () => {
		await initSodium();

		for (const v of testVectors.vectors.xchacha20poly1305) {
			const ciphertext = fromBase64(v.ciphertext);
			const nonce = fromBase64(v.nonce);
			const key = fromBase64(v.key);
			const expectedPlaintext = fromBase64(v.plaintext);

			const decrypted = decryptRaw(ciphertext, nonce, key);
			expect(decrypted).toEqual(expectedPlaintext);
		}
	});

	test("argon2id vectors derive correct keys", async () => {
		await initSodium();

		for (const v of testVectors.vectors.argon2id) {
			const salt = fromBase64(v.salt);
			const baseKey = fromBase64(v.baseKey);
			const expected = fromBase64(v.derivedKey);

			const derived = deriveKeyFromPassword(v.password, salt, baseKey);
			expect(derived).toEqual(expected);
		}
	});

	test("pipeline vectors decrypt to correct payloads", async () => {
		await initSodium();

		for (const v of testVectors.vectors.pipeline) {
			const ciphertext = fromBase64(v.ciphertext);
			const nonce = fromBase64(v.nonce);
			const key = fromBase64(v.key);

			const payload = decryptPayload(ciphertext, nonce, key);
			expect(payload.text).toBe(v.payload.text);
			expect(payload.contentMode).toBe(v.payload.contentMode);

			if (v.payload.files) {
				expect(payload.files).toHaveLength(v.payload.files.length);
				for (let i = 0; i < v.payload.files.length; i++) {
					const expected = v.payload.files[i];
					const actual = payload.files?.[i];
					expect(expected).toBeDefined();
					expect(actual).toBeDefined();
					expect(actual?.name).toBe(expected?.name);
					expect(actual?.type).toBe(expected?.type);
					expect(actual?.size).toBe(expected?.size);
				}
			}
		}
	});

	test("encoding vectors produce correct base64url", async () => {
		await initSodium();

		for (const v of testVectors.vectors.encoding) {
			const raw = fromBase64(v.raw);
			expect(keyToBase64Url(raw)).toBe(v.base64url);
			expect(keyFromBase64Url(v.base64url)).toEqual(raw);
		}
	});
});

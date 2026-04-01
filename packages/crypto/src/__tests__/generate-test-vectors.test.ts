/**
 * One-shot script to generate deterministic crypto test vectors.
 * Run with: docker compose -f docker-compose.dev.yml run --rm app pnpm vitest run packages/crypto/src/__tests__/generate-test-vectors.test.ts
 */

import { encode } from "@msgpack/msgpack";
import type { NotePayload } from "@secret/shared";
import sodium from "libsodium-wrappers-sumo";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";

test("generate test vectors", async () => {
	await sodium.ready;

	function toB64(data: Uint8Array): string {
		return sodium.to_base64(data, sodium.base64_variants.ORIGINAL);
	}

	function toB64Url(data: Uint8Array): string {
		return sodium.to_base64(data, sodium.base64_variants.URLSAFE_NO_PADDING);
	}

	// --- Fixed inputs (deterministic, not random) ---

	const KEY_32 = new Uint8Array([
		0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
		0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f,
	]);

	const NONCE_24 = new Uint8Array([
		0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xab, 0xac, 0xad, 0xae, 0xaf,
		0xb0, 0xb1, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7,
	]);

	const SALT_16 = new Uint8Array([
		0xc0, 0xc1, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xcb, 0xcc, 0xcd, 0xce, 0xcf,
	]);

	const BASE_KEY_32 = new Uint8Array([
		0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2d, 0x2e, 0x2f,
		0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0x3f,
	]);

	// --- XChaCha20-Poly1305 vectors ---

	const emptyPlaintext = new Uint8Array(0);
	const emptyCiphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
		emptyPlaintext,
		null,
		null,
		NONCE_24,
		KEY_32,
	);

	const shortPlaintext = new TextEncoder().encode("Hello, Secret!");
	const shortCiphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
		shortPlaintext,
		null,
		null,
		NONCE_24,
		KEY_32,
	);

	// --- Argon2id vectors ---

	const combinedInput = `test-password-123:${toB64Url(BASE_KEY_32)}`;
	const derivedKey = sodium.crypto_pwhash(
		sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES,
		combinedInput,
		SALT_16,
		sodium.crypto_pwhash_OPSLIMIT_MODERATE,
		sodium.crypto_pwhash_MEMLIMIT_MODERATE,
		sodium.crypto_pwhash_ALG_ARGON2ID13,
	);

	// --- Pipeline vectors (full note encryption) ---

	const textPayload: NotePayload = { text: "Hello, world!", contentMode: "text" };
	const textMsgpack = encode(textPayload);
	const textCiphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
		textMsgpack,
		null,
		null,
		NONCE_24,
		KEY_32,
	);

	const fileData = new TextEncoder().encode("secret file content");
	const filePayload: NotePayload = {
		text: "Note with file",
		contentMode: "text",
		files: [{ name: "test.txt", type: "text/plain", size: fileData.length, data: fileData }],
	};
	const fileMsgpack = encode(filePayload);
	const fileCiphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
		fileMsgpack,
		null,
		null,
		NONCE_24,
		KEY_32,
	);

	// --- Build vectors object ---

	const vectors = {
		version: 1,
		generatedWith: `libsodium-wrappers-sumo ${sodium.SODIUM_VERSION_STRING}`,
		vectors: {
			xchacha20poly1305: [
				{
					description: "encrypt empty plaintext",
					key: toB64(KEY_32),
					nonce: toB64(NONCE_24),
					plaintext: toB64(emptyPlaintext),
					ciphertext: toB64(emptyCiphertext),
				},
				{
					description: "encrypt short plaintext",
					key: toB64(KEY_32),
					nonce: toB64(NONCE_24),
					plaintext: toB64(shortPlaintext),
					ciphertext: toB64(shortCiphertext),
				},
			],
			argon2id: [
				{
					description: "derive key from password with base key",
					password: "test-password-123",
					salt: toB64(SALT_16),
					baseKey: toB64(BASE_KEY_32),
					baseKeyUrl: toB64Url(BASE_KEY_32),
					combinedInput,
					opsLimit: sodium.crypto_pwhash_OPSLIMIT_MODERATE,
					memLimit: sodium.crypto_pwhash_MEMLIMIT_MODERATE,
					algorithm: "argon2id13",
					derivedKey: toB64(derivedKey),
				},
			],
			pipeline: [
				{
					description: "text-only note, no password",
					payload: { text: "Hello, world!", contentMode: "text" },
					payloadMsgpack: toB64(textMsgpack),
					key: toB64(KEY_32),
					nonce: toB64(NONCE_24),
					ciphertext: toB64(textCiphertext),
				},
				{
					description: "note with file, no password",
					payload: {
						text: "Note with file",
						contentMode: "text",
						files: [
							{
								name: "test.txt",
								type: "text/plain",
								size: fileData.length,
								data: toB64(fileData),
							},
						],
					},
					payloadMsgpack: toB64(fileMsgpack),
					key: toB64(KEY_32),
					nonce: toB64(NONCE_24),
					ciphertext: toB64(fileCiphertext),
				},
			],
			encoding: [
				{
					description: "base64url key encoding (32 bytes)",
					raw: toB64(KEY_32),
					base64url: toB64Url(KEY_32),
				},
				{
					description: "base64url key encoding (32 bytes, alternate)",
					raw: toB64(BASE_KEY_32),
					base64url: toB64Url(BASE_KEY_32),
				},
			],
		},
	};

	const outDir = resolve(import.meta.dirname!, "../../../shared/src/test-vectors");
	mkdirSync(outDir, { recursive: true });
	const outPath = resolve(outDir, "vectors.json");
	writeFileSync(outPath, JSON.stringify(vectors, null, "\t") + "\n");

	expect(vectors.vectors.xchacha20poly1305).toHaveLength(2);
	expect(vectors.vectors.argon2id).toHaveLength(1);
	expect(vectors.vectors.pipeline).toHaveLength(2);
	expect(vectors.vectors.encoding).toHaveLength(2);
});

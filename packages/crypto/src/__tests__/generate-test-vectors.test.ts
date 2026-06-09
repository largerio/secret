/**
 * One-shot script to generate deterministic crypto test vectors.
 * Run with: docker compose -f docker-compose.dev.yml run --rm app pnpm vitest run packages/crypto/src/__tests__/generate-test-vectors.test.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { NotePayload } from "@largerio/shared";
import { encode } from "@msgpack/msgpack";
import sodium from "libsodium-wrappers-sumo";
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

	// Second deterministic salt + base key, used for the additional Argon2id and
	// password-protected pipeline vectors so cross-language implementations are
	// validated against more than a single fixture.
	const SALT_16_B = new Uint8Array([
		0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xdb, 0xdc, 0xdd, 0xde, 0xdf,
	]);

	const BASE_KEY_32_B = new Uint8Array([
		0x40, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x4b, 0x4c, 0x4d, 0x4e, 0x4f,
		0x50, 0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x5b, 0x5c, 0x5d, 0x5e, 0x5f,
	]);

	const encryptXcc = (plaintext: Uint8Array, key: Uint8Array = KEY_32): Uint8Array =>
		sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, null, null, NONCE_24, key);

	const deriveKey = (password: string, salt: Uint8Array, baseKey: Uint8Array): Uint8Array =>
		sodium.crypto_pwhash(
			sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES,
			`${password}:${toB64Url(baseKey)}`,
			salt,
			sodium.crypto_pwhash_OPSLIMIT_MODERATE,
			sodium.crypto_pwhash_MEMLIMIT_MODERATE,
			sodium.crypto_pwhash_ALG_ARGON2ID13,
		);

	// --- XChaCha20-Poly1305 vectors ---

	const emptyPlaintext = new Uint8Array(0);
	const emptyCiphertext = encryptXcc(emptyPlaintext);

	const shortPlaintext = new TextEncoder().encode("Hello, Secret!");
	const shortCiphertext = encryptXcc(shortPlaintext);

	// Exactly one XChaCha20 block (64 bytes) to catch off-by-one block handling.
	const blockPlaintext = new Uint8Array(64).map((_, i) => i);
	const blockCiphertext = encryptXcc(blockPlaintext);

	// Several blocks (256 bytes) to exercise multi-block keystream paths.
	const multiBlockPlaintext = new Uint8Array(256).map((_, i) => i & 0xff);
	const multiBlockCiphertext = encryptXcc(multiBlockPlaintext);

	// Binary payload containing boundary bytes (0x00 and 0xff) that text-oriented
	// implementations often mishandle.
	const binaryPlaintext = new Uint8Array([0x00, 0xff, 0x00, 0xff, 0x10, 0x7f, 0x80, 0xfe, 0x01]);
	const binaryCiphertext = encryptXcc(binaryPlaintext);

	// --- Argon2id vectors ---

	const combinedInput = `test-password-123:${toB64Url(BASE_KEY_32)}`;
	const derivedKey = deriveKey("test-password-123", SALT_16, BASE_KEY_32);

	// Second vector with a different (non-ASCII) password and distinct salt/base key.
	const password2 = "Pässwörd-2!🔒";
	const combinedInput2 = `${password2}:${toB64Url(BASE_KEY_32_B)}`;
	const derivedKey2 = deriveKey(password2, SALT_16_B, BASE_KEY_32_B);

	// --- Pipeline vectors (full note encryption) ---

	const textPayload: NotePayload = { text: "Hello, world!", contentMode: "text" };
	const textMsgpack = encode(textPayload);
	const textCiphertext = encryptXcc(textMsgpack);

	const fileData = new TextEncoder().encode("secret file content");
	const filePayload: NotePayload = {
		text: "Note with file",
		contentMode: "text",
		files: [{ name: "test.txt", type: "text/plain", size: fileData.length, data: fileData }],
	};
	const fileMsgpack = encode(filePayload);
	const fileCiphertext = encryptXcc(fileMsgpack);

	// Password-protected note: the sealing key is derived from the password, so a
	// cross-language client must reproduce the Argon2id derivation to decrypt.
	const pwPassword = "note-password-9";
	const pwKey = deriveKey(pwPassword, SALT_16, BASE_KEY_32);
	const pwPayload: NotePayload = { text: "password protected", contentMode: "text" };
	const pwMsgpack = encode(pwPayload);
	const pwCiphertext = encryptXcc(pwMsgpack, pwKey);

	// Note carrying a zero-byte file (empty `data`).
	const emptyFileData = new Uint8Array(0);
	const emptyFilePayload: NotePayload = {
		text: "empty file",
		contentMode: "text",
		files: [{ name: "empty.bin", type: "application/octet-stream", size: 0, data: emptyFileData }],
	};
	const emptyFileMsgpack = encode(emptyFilePayload);
	const emptyFileCiphertext = encryptXcc(emptyFileMsgpack);

	// Note carrying multiple files.
	const fileA = new TextEncoder().encode("file A content");
	const fileB = new Uint8Array([0x00, 0x01, 0x02, 0xfd, 0xfe, 0xff]);
	const multiFilePayload: NotePayload = {
		text: "two files",
		contentMode: "text",
		files: [
			{ name: "a.txt", type: "text/plain", size: fileA.length, data: fileA },
			{ name: "b.bin", type: "application/octet-stream", size: fileB.length, data: fileB },
		],
	};
	const multiFileMsgpack = encode(multiFilePayload);
	const multiFileCiphertext = encryptXcc(multiFileMsgpack);

	// --- Build vectors object ---

	const vectors = {
		version: 2,
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
				{
					description: "encrypt one-block (64 byte) plaintext",
					key: toB64(KEY_32),
					nonce: toB64(NONCE_24),
					plaintext: toB64(blockPlaintext),
					ciphertext: toB64(blockCiphertext),
				},
				{
					description: "encrypt multi-block (256 byte) plaintext",
					key: toB64(KEY_32),
					nonce: toB64(NONCE_24),
					plaintext: toB64(multiBlockPlaintext),
					ciphertext: toB64(multiBlockCiphertext),
				},
				{
					description: "encrypt binary plaintext with 0x00/0xff bytes",
					key: toB64(KEY_32),
					nonce: toB64(NONCE_24),
					plaintext: toB64(binaryPlaintext),
					ciphertext: toB64(binaryCiphertext),
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
				{
					description: "derive key from non-ASCII password with alternate base key",
					password: password2,
					salt: toB64(SALT_16_B),
					baseKey: toB64(BASE_KEY_32_B),
					baseKeyUrl: toB64Url(BASE_KEY_32_B),
					combinedInput: combinedInput2,
					opsLimit: sodium.crypto_pwhash_OPSLIMIT_MODERATE,
					memLimit: sodium.crypto_pwhash_MEMLIMIT_MODERATE,
					algorithm: "argon2id13",
					derivedKey: toB64(derivedKey2),
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
				{
					description: "text note, password-protected (key derived via Argon2id)",
					payload: { text: "password protected", contentMode: "text" },
					payloadMsgpack: toB64(pwMsgpack),
					key: toB64(pwKey),
					nonce: toB64(NONCE_24),
					ciphertext: toB64(pwCiphertext),
					password: pwPassword,
					salt: toB64(SALT_16),
					baseKey: toB64(BASE_KEY_32),
				},
				{
					description: "note with an empty (zero-byte) file",
					payload: {
						text: "empty file",
						contentMode: "text",
						files: [
							{
								name: "empty.bin",
								type: "application/octet-stream",
								size: 0,
								data: toB64(emptyFileData),
							},
						],
					},
					payloadMsgpack: toB64(emptyFileMsgpack),
					key: toB64(KEY_32),
					nonce: toB64(NONCE_24),
					ciphertext: toB64(emptyFileCiphertext),
				},
				{
					description: "note with multiple files",
					payload: {
						text: "two files",
						contentMode: "text",
						files: [
							{ name: "a.txt", type: "text/plain", size: fileA.length, data: toB64(fileA) },
							{
								name: "b.bin",
								type: "application/octet-stream",
								size: fileB.length,
								data: toB64(fileB),
							},
						],
					},
					payloadMsgpack: toB64(multiFileMsgpack),
					key: toB64(KEY_32),
					nonce: toB64(NONCE_24),
					ciphertext: toB64(multiFileCiphertext),
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
				{
					description: "base64url encoding (3 bytes, 0 padding)",
					raw: toB64(new Uint8Array([0x01, 0x02, 0x03])),
					base64url: toB64Url(new Uint8Array([0x01, 0x02, 0x03])),
				},
				{
					description: "base64url encoding (4 bytes, 2 padding chars)",
					raw: toB64(new Uint8Array([0x01, 0x02, 0x03, 0x04])),
					base64url: toB64Url(new Uint8Array([0x01, 0x02, 0x03, 0x04])),
				},
				{
					description: "base64url encoding (5 bytes, 1 padding char)",
					raw: toB64(new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05])),
					base64url: toB64Url(new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05])),
				},
				{
					description: "base64url encoding (all-zero bytes)",
					raw: toB64(new Uint8Array(16)),
					base64url: toB64Url(new Uint8Array(16)),
				},
				{
					description: "base64url encoding (all-0xff bytes)",
					raw: toB64(new Uint8Array(16).fill(0xff)),
					base64url: toB64Url(new Uint8Array(16).fill(0xff)),
				},
			],
		},
	};

	const dirname = import.meta.dirname;
	if (!dirname) {
		throw new Error("import.meta.dirname is undefined");
	}
	const outDir = resolve(dirname, "../../../shared/src/test-vectors");
	mkdirSync(outDir, { recursive: true });
	const outPath = resolve(outDir, "vectors.json");
	writeFileSync(outPath, `${JSON.stringify(vectors, null, "\t")}\n`);

	expect(vectors.vectors.xchacha20poly1305).toHaveLength(5);
	expect(vectors.vectors.argon2id).toHaveLength(2);
	expect(vectors.vectors.pipeline).toHaveLength(5);
	expect(vectors.vectors.encoding).toHaveLength(7);
});

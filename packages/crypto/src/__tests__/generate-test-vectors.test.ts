/**
 * Deterministic crypto test vectors, frozen in packages/shared/src/test-vectors/vectors.json.
 *
 * Every run recomputes them with libsodium and fails if the committed file says
 * otherwise, instead of rewriting the file that test-vectors.test.ts and
 * vectors-openssl.test.ts check the code against. After a deliberate format
 * change, write the new file with:
 *   docker compose -f docker-compose.dev.yml run --rm -e UPDATE_TEST_VECTORS=1 app \
 *     pnpm vitest run packages/crypto/src/__tests__/generate-test-vectors.test.ts
 */

import { createHmac, hkdfSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { NotePayload } from "@largerio/secret-shared";
import { encode } from "@msgpack/msgpack";
import sodium from "libsodium-wrappers-sumo";
import { expect, test } from "vitest";

test("the committed test vectors match what the crypto produces", async () => {
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

	// --- Secretstream vectors (chunked notes) ---

	// A chunked note is one secretstream: first the MessagePack of its text and
	// file metadata, then each file's bytes cut at chunkSize, the last chunk
	// tagged FINAL. The stream header is random (init_push draws it), so these
	// are written once: a normal run checks every other field against the file
	// and leaves the header and the chunks as committed.
	const streamPlaintexts = (payload: NotePayload, chunkSize: number) => {
		const files = payload.files ?? [];
		const headerBytes = encode({
			...(payload.text !== undefined ? { text: payload.text } : {}),
			...(payload.contentMode ? { contentMode: payload.contentMode } : {}),
			...(files.length > 0
				? { files: files.map(({ name, type, size }) => ({ name, type, size })) }
				: {}),
		});
		const pieces: Uint8Array[] = [headerBytes];
		for (const file of files) {
			for (let offset = 0; offset < file.data.length; offset += chunkSize) {
				pieces.push(file.data.subarray(offset, offset + chunkSize));
			}
		}
		return { headerBytes, pieces };
	};

	const payloadJson = (payload: NotePayload) => {
		const files = payload.files ?? [];
		return {
			...payload,
			...(files.length > 0
				? { files: files.map((file) => ({ ...file, data: toB64(file.data) })) }
				: {}),
		};
	};

	const secretstreamVector = (description: string, payload: NotePayload, chunkSize: number) => {
		const { headerBytes, pieces } = streamPlaintexts(payload, chunkSize);
		const { state, header } = sodium.crypto_secretstream_xchacha20poly1305_init_push(KEY_32);
		const chunks = pieces.map((piece, i) =>
			sodium.crypto_secretstream_xchacha20poly1305_push(
				state,
				piece,
				null,
				i === pieces.length - 1
					? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL
					: sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE,
			),
		);
		return {
			description,
			key: toB64(KEY_32),
			keyFragment: toB64Url(KEY_32),
			chunkSize,
			payload: payloadJson(payload),
			headerMsgpack: toB64(headerBytes),
			header: toB64(header),
			chunks: chunks.map(toB64),
		};
	};

	const streamFileA = new Uint8Array(10).map((_, i) => i);
	const streamFileB = new TextEncoder().encode("tail");
	const streamFiles = secretstreamVector(
		"two files over five chunks: a 10-byte file in 4-byte chunks, then a 4-byte file",
		{
			text: "chunked",
			contentMode: "text",
			files: [
				{ name: "a.bin", type: "application/octet-stream", size: 10, data: streamFileA },
				{ name: "b.txt", type: "text/plain", size: 4, data: streamFileB },
			],
		},
		4,
	);
	const streamTextOnly = secretstreamVector(
		"text only: the metadata chunk is the final one",
		{ text: "only text", contentMode: "markdown" },
		4,
	);

	// --- Format 1 vectors ---

	// Computed apart from the crypto package: HKDF and HMAC from node:crypto,
	// the envelope laid out by hand.
	type Argon2 = {
		readonly salt: Uint8Array;
		readonly iterations: number;
		readonly memoryKiB: number;
	};
	type Settings = {
		readonly fileCount: number;
		readonly maxReads: number;
		readonly expiresIn: number;
	};

	// libsodium's moderate setting, what a writer uses, and the lightest a
	// reader accepts, to keep the vectors quick to check.
	const DEFAULT_ARGON2 = { iterations: 3, memoryKiB: 262_144 };
	const LIGHT_ARGON2 = { iterations: 1, memoryKiB: 65_536 };

	const argon2Json = (argon2: Argon2) => ({ ...argon2, salt: toB64(argon2.salt) });

	const format1Keys = (linkKey: Uint8Array, password?: string, argon2?: Argon2) => {
		const stretched =
			password !== undefined && argon2
				? sodium.crypto_pwhash(
						32,
						Buffer.concat([Buffer.from(password.normalize("NFC"), "utf8"), linkKey]),
						argon2.salt,
						argon2.iterations,
						argon2.memoryKiB * 1024,
						sodium.crypto_pwhash_ALG_ARGON2ID13,
					)
				: undefined;
		const ikm = stretched ? Buffer.concat([linkKey, stretched]) : Buffer.from(linkKey);
		const prk = createHmac("sha256", Buffer.alloc(32)).update(ikm).digest();
		const encryptionKey = new Uint8Array(
			hkdfSync("sha256", ikm, Buffer.alloc(0), "secret/1 enc", 32),
		);
		return { stretched, prk, encryptionKey, keyFragment: `1.${toB64Url(linkKey)}` };
	};

	const keyVector = (
		description: string,
		linkKey: Uint8Array,
		password?: string,
		argon2?: Argon2,
	) => {
		const keys = format1Keys(linkKey, password, argon2);
		return {
			description,
			linkKey: toB64(linkKey),
			keyFragment: keys.keyFragment,
			...(password !== undefined && argon2 && keys.stretched
				? { password, argon2: argon2Json(argon2), stretchedPassword: toB64(keys.stretched) }
				: {}),
			prk: toB64(keys.prk),
			encryptionKey: toB64(keys.encryptionKey),
		};
	};

	const envelopeBytes = (
		kind: "single-shot" | "chunked",
		settings: Settings,
		nonce: Uint8Array,
		argon2?: Argon2,
	): Uint8Array => {
		const head = Buffer.alloc(10);
		head[0] = 1;
		head[1] = kind === "single-shot" ? 0 : 1;
		head[2] = argon2 ? 1 : 0;
		head[3] = settings.fileCount;
		head.writeUInt16BE(settings.maxReads, 4);
		head.writeUInt32BE(settings.expiresIn, 6);
		const parts = [head, Buffer.from(nonce)];
		if (argon2) {
			const params = Buffer.alloc(8);
			params.writeUInt32BE(argon2.iterations, 0);
			params.writeUInt32BE(argon2.memoryKiB, 4);
			parts.push(Buffer.from(argon2.salt), params);
		}
		return new Uint8Array(Buffer.concat(parts));
	};

	const envelopeVector = (
		description: string,
		kind: "single-shot" | "chunked",
		settings: Settings,
		nonce: Uint8Array,
		argon2?: Argon2,
	) => ({
		description,
		kind,
		...settings,
		nonce: toB64(nonce),
		...(argon2 ? { argon2: argon2Json(argon2) } : {}),
		envelope: toB64(envelopeBytes(kind, settings, nonce, argon2)),
	});

	const format1PipelineVector = (
		description: string,
		linkKey: Uint8Array,
		settings: Settings,
		payload: NotePayload,
		password?: string,
		argon2?: Argon2,
	) => {
		const keys = format1Keys(linkKey, password, argon2);
		const envelope = envelopeBytes("single-shot", settings, NONCE_24, argon2);
		const msgpack = encode(payload);
		const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
			msgpack,
			envelope,
			null,
			NONCE_24,
			keys.encryptionKey,
		);
		return {
			description,
			keyFragment: keys.keyFragment,
			...(password !== undefined ? { password } : {}),
			encryptionKey: toB64(keys.encryptionKey),
			envelope: toB64(envelope),
			payload: payloadJson(payload),
			payloadMsgpack: toB64(msgpack),
			ciphertext: toB64(ciphertext),
		};
	};

	const format1SecretstreamVector = (
		description: string,
		linkKey: Uint8Array,
		settings: Settings,
		payload: NotePayload,
		chunkSize: number,
		password?: string,
		argon2?: Argon2,
	) => {
		const keys = format1Keys(linkKey, password, argon2);
		const { headerBytes, pieces } = streamPlaintexts(payload, chunkSize);
		const { state, header } = sodium.crypto_secretstream_xchacha20poly1305_init_push(
			keys.encryptionKey,
		);
		const envelope = envelopeBytes("chunked", settings, header, argon2);
		const chunks = pieces.map((piece, i) =>
			sodium.crypto_secretstream_xchacha20poly1305_push(
				state,
				piece,
				envelope,
				i === pieces.length - 1
					? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL
					: sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE,
			),
		);
		return {
			description,
			keyFragment: keys.keyFragment,
			...(password !== undefined ? { password } : {}),
			encryptionKey: toB64(keys.encryptionKey),
			envelope: toB64(envelope),
			chunkSize,
			payload: payloadJson(payload),
			headerMsgpack: toB64(headerBytes),
			chunks: chunks.map(toB64),
		};
	};

	const STREAM_HEADER_24 = new Uint8Array(24).map((_, i) => 0xe0 + i);
	// "Pässwörd-2!🔒" decomposed: the derivation normalizes it to NFC first.
	const nfdPassword = "Pässwörd-2!🔒".normalize("NFD");
	const defaultArgon2 = { salt: SALT_16, ...DEFAULT_ARGON2 };
	const lightArgon2 = { salt: SALT_16_B, ...LIGHT_ARGON2 };
	const oneDay = { fileCount: 0, maxReads: 1, expiresIn: 86_400 };

	const format1 = {
		keys: [
			keyVector("no password: the link's key alone", KEY_32),
			keyVector(
				"password, with the parameters a writer uses",
				BASE_KEY_32,
				"test-password-123",
				defaultArgon2,
			),
			keyVector("password typed in NFD, light parameters", BASE_KEY_32_B, nfdPassword, lightArgon2),
		],
		envelopes: [
			envelopeVector("single-shot note, no password", "single-shot", oneDay, NONCE_24),
			envelopeVector(
				"chunked note with a password",
				"chunked",
				{ fileCount: 3, maxReads: 0, expiresIn: 2_592_000 },
				STREAM_HEADER_24,
				defaultArgon2,
			),
		],
		pipeline: [
			format1PipelineVector("text-only note, no password", KEY_32, oneDay, {
				text: "Hello, world!",
				contentMode: "text",
			}),
			format1PipelineVector(
				"two files, password typed in NFD",
				BASE_KEY_32_B,
				{ fileCount: 2, maxReads: 3, expiresIn: 3600 },
				multiFilePayload,
				nfdPassword,
				lightArgon2,
			),
		],
		secretstream: [
			format1SecretstreamVector(
				"two files over five chunks, no password",
				KEY_32,
				{ fileCount: 2, maxReads: 1, expiresIn: 86_400 },
				{
					text: "chunked",
					contentMode: "text",
					files: [
						{ name: "a.bin", type: "application/octet-stream", size: 10, data: streamFileA },
						{ name: "b.txt", type: "text/plain", size: 4, data: streamFileB },
					],
				},
				4,
			),
			format1SecretstreamVector(
				"text only, password: the head is the final chunk",
				BASE_KEY_32_B,
				{ fileCount: 0, maxReads: 0, expiresIn: 300 },
				{ text: "only text", contentMode: "markdown" },
				4,
				nfdPassword,
				lightArgon2,
			),
		],
	};

	// --- Build vectors object ---

	const vectors = {
		version: 3,
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
			secretstream: [streamFiles, streamTextOnly],
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
			format1,
		},
	};

	const dirname = import.meta.dirname;
	if (!dirname) {
		throw new Error("import.meta.dirname is undefined");
	}
	const outPath = resolve(dirname, "../../../shared/src/test-vectors/vectors.json");
	if (process.env["UPDATE_TEST_VECTORS"] === "1") {
		// In CI the flag would only make this test pass, against the file it wrote.
		if (process.env["CI"]) throw new Error("UPDATE_TEST_VECTORS is for a deliberate local change");
		writeFileSync(outPath, `${JSON.stringify(vectors, null, "\t")}\n`);
	}

	// generatedWith only records the libsodium that wrote the file: another
	// release producing the same bytes is no change. The secretstream headers
	// and chunks are random, so they are taken as committed; so is the header
	// inside a format 1 envelope, whose other bytes must match.
	const committed = JSON.parse(readFileSync(outPath, "utf8")) as typeof vectors;
	const withCommittedHeader = (envelope: string, committedEnvelope: string | undefined) => {
		const bytes = Buffer.from(envelope, "base64");
		Buffer.from(committedEnvelope ?? "", "base64").copy(bytes, 10, 10, 34);
		return bytes.toString("base64");
	};
	expect({
		...vectors,
		generatedWith: committed.generatedWith,
		vectors: {
			...vectors.vectors,
			secretstream: vectors.vectors.secretstream.map((v, i) => ({
				...v,
				header: committed.vectors.secretstream[i]?.header,
				chunks: committed.vectors.secretstream[i]?.chunks,
			})),
			format1: {
				...vectors.vectors.format1,
				secretstream: vectors.vectors.format1.secretstream.map((v, i) => {
					const written = committed.vectors.format1.secretstream[i];
					return {
						...v,
						envelope: withCommittedHeader(v.envelope, written?.envelope),
						chunks: written?.chunks,
					};
				}),
			},
		},
	}).toEqual(committed);

	expect(vectors.vectors.xchacha20poly1305).toHaveLength(5);
	expect(vectors.vectors.argon2id).toHaveLength(2);
	expect(vectors.vectors.pipeline).toHaveLength(5);
	expect(vectors.vectors.encoding).toHaveLength(7);
	expect(vectors.vectors.secretstream).toHaveLength(2);
	expect(vectors.vectors.format1.keys).toHaveLength(3);
	expect(vectors.vectors.format1.envelopes).toHaveLength(2);
	expect(vectors.vectors.format1.pipeline).toHaveLength(2);
	expect(vectors.vectors.format1.secretstream).toHaveLength(2);
}, 60_000);

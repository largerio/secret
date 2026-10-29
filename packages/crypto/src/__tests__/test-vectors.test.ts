import { type NotePayload, parseEnvelope, testVectors } from "@largerio/secret-shared";
import { describe, expect, test } from "vitest";
import {
	decodeRawBytes,
	decryptChunk,
	decryptPayload,
	decryptRaw,
	initStreamDecrypt,
} from "../decrypt.js";
import { encodePayload } from "../encrypt.js";
import { deriveFormat1Keys, hkdfExtract, stretchPassword, verifierOf } from "../format1.js";
import {
	deriveKeyFromPassword,
	fromBase64,
	initSodium,
	keyFromBase64Url,
	keyToBase64Url,
	toBase64,
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
			const nonce = fromBase64(v.nonce);

			// For password-protected vectors, the sealing key must be reproducible by
			// running the Argon2id derivation — proving the end-to-end password path.
			let key = fromBase64(v.key);
			if (v.password !== undefined) {
				expect(v.salt).toBeDefined();
				expect(v.baseKey).toBeDefined();
				const derived = deriveKeyFromPassword(
					v.password,
					fromBase64(v.salt as string),
					fromBase64(v.baseKey as string),
				);
				expect(derived).toEqual(key);
				key = derived;
			}

			const payload = decryptPayload(fromBase64(v.ciphertext), nonce, key);
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
					expect(actual?.data).toEqual(fromBase64(expected?.data as string));
				}
			}
		}
	});

	// Decrypting proves the reader; this pins the writer, so a change to how a
	// payload is encoded cannot pass while new notes no longer match the file.
	test("pipeline payloads encode to the recorded MessagePack", () => {
		for (const v of testVectors.vectors.pipeline) {
			const payload = {
				...v.payload,
				...(v.payload.files
					? { files: v.payload.files.map((file) => ({ ...file, data: fromBase64(file.data) })) }
					: {}),
			};
			expect(encodePayload(payload as NotePayload), v.description).toEqual(
				fromBase64(v.payloadMsgpack),
			);
		}
	});

	test("secretstream vectors open chunk by chunk, FINAL on the last", async () => {
		await initSodium();

		for (const v of testVectors.vectors.secretstream) {
			const state = initStreamDecrypt(fromBase64(v.header), fromBase64(v.key));
			const chunks = v.chunks.map((chunk) => decryptChunk(state, fromBase64(chunk)));

			expect(
				chunks.map((chunk) => chunk.isFinal),
				v.description,
			).toEqual(v.chunks.map((_, i) => i === v.chunks.length - 1));
			const [first, ...rest] = chunks;
			expect(first?.decrypted).toEqual(fromBase64(v.headerMsgpack));
			expect(decodeRawBytes(fromBase64(v.headerMsgpack))).toEqual({
				text: v.payload.text,
				contentMode: v.payload.contentMode,
				...(v.payload.files
					? { files: v.payload.files.map(({ name, type, size }) => ({ name, type, size })) }
					: {}),
			});
			const data = Buffer.concat(rest.map((chunk) => chunk.decrypted));
			const files = Buffer.concat((v.payload.files ?? []).map((file) => fromBase64(file.data)));
			expect(new Uint8Array(data)).toEqual(new Uint8Array(files));
			expect(rest.every((chunk) => chunk.decrypted.length <= v.chunkSize)).toBe(true);
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

	describe("format 1", () => {
		const { format1 } = testVectors.vectors;

		const argon2Of = (argon2: { salt: string; iterations: number; memoryKiB: number }) => ({
			...argon2,
			salt: fromBase64(argon2.salt),
		});

		test("keys derive as the vectors record", async () => {
			await initSodium();

			for (const v of format1.keys) {
				const linkKey = fromBase64(v.linkKey);
				expect(`1.${keyToBase64Url(linkKey)}`, v.description).toBe(v.keyFragment);

				const password =
					v.password !== undefined && v.argon2
						? { password: v.password, argon2: argon2Of(v.argon2) }
						: undefined;
				let ikm = linkKey;
				if (password) {
					const stretched = stretchPassword(password, linkKey);
					expect(toBase64(stretched), v.description).toBe(v.stretchedPassword);
					ikm = new Uint8Array([...linkKey, ...stretched]);
				}
				expect(toBase64(hkdfExtract(ikm)), v.description).toBe(v.prk);
				const keys = deriveFormat1Keys(linkKey, password);
				expect(toBase64(keys.encryptionKey), v.description).toBe(v.encryptionKey);
				expect(toBase64(keys.linkProof), v.description).toBe(v.linkProof);
				expect(toBase64(verifierOf(keys.linkProof)), v.description).toBe(v.linkVerifier);
				expect(keys.passwordProof && toBase64(keys.passwordProof), v.description).toBe(
					v.passwordProof,
				);
				expect(keys.passwordProof && toBase64(verifierOf(keys.passwordProof)), v.description).toBe(
					v.passwordVerifier,
				);
			}
		}, 30_000);

		test("single-shot notes open under their envelope", async () => {
			await initSodium();

			for (const v of format1.pipeline) {
				const envelopeBytes = fromBase64(v.envelope);
				const envelope = parseEnvelope(envelopeBytes);
				if (envelope?.kind !== "single-shot") throw new Error(v.description);

				const key = fromBase64(v.encryptionKey);
				const plaintext = decryptRaw(fromBase64(v.ciphertext), envelope.nonce, key, envelopeBytes);
				expect(toBase64(plaintext), v.description).toBe(v.payloadMsgpack);
				expect(() => decryptRaw(fromBase64(v.ciphertext), envelope.nonce, key)).toThrow();
			}
		});

		test("chunked notes open chunk by chunk under their envelope, FINAL on the last", async () => {
			await initSodium();

			for (const v of format1.secretstream) {
				const envelopeBytes = fromBase64(v.envelope);
				const envelope = parseEnvelope(envelopeBytes);
				if (envelope?.kind !== "chunked") throw new Error(v.description);

				const state = initStreamDecrypt(envelope.streamHeader, fromBase64(v.encryptionKey));
				const chunks = v.chunks.map((chunk) =>
					decryptChunk(state, fromBase64(chunk), envelopeBytes),
				);
				expect(
					chunks.map((chunk) => chunk.isFinal),
					v.description,
				).toEqual(v.chunks.map((_, i) => i === v.chunks.length - 1));
				expect(chunks[0]?.decrypted).toEqual(fromBase64(v.headerMsgpack));
				const data = Buffer.concat(chunks.slice(1).map((chunk) => chunk.decrypted));
				const files = Buffer.concat((v.payload.files ?? []).map((file) => fromBase64(file.data)));
				expect(new Uint8Array(data)).toEqual(new Uint8Array(files));
			}
		});
	});
});

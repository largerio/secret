import { argon2Sync, createDecipheriv, hkdfSync } from "node:crypto";
import { testVectors } from "@largerio/secret-shared";
import { decode } from "@msgpack/msgpack";
import { describe, expect, test } from "vitest";

/*
 * The committed vectors, checked by a second implementation: OpenSSL, through
 * node:crypto, which shares no code with libsodium. XChaCha20-Poly1305 is
 * HChaCha20 (below, checked against its specification) for the subkey, then
 * OpenSSL's ChaCha20-Poly1305; Argon2id is OpenSSL's. What both agree on is
 * the format, rather than one library's behaviour, and another client can be
 * written against it.
 */

const { vectors } = testVectors;

const rotl = (value: number, bits: number): number =>
	((value << bits) | (value >>> (32 - bits))) >>> 0;

/** HChaCha20 (draft-irtf-cfrg-xchacha, section 2.2): a 32-byte subkey. */
function hchacha20(key: Uint8Array, nonce16: Uint8Array): Buffer {
	const k = Buffer.from(key);
	const n = Buffer.from(nonce16);
	const state = new Uint32Array(16);
	state.set([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);
	for (let i = 0; i < 8; i++) state[4 + i] = k.readUInt32LE(i * 4);
	for (let i = 0; i < 4; i++) state[12 + i] = n.readUInt32LE(i * 4);

	const at = (i: number): number => state[i] ?? 0;
	const quarter = (a: number, b: number, c: number, d: number): void => {
		state[a] = at(a) + at(b);
		state[d] = rotl(at(d) ^ at(a), 16);
		state[c] = at(c) + at(d);
		state[b] = rotl(at(b) ^ at(c), 12);
		state[a] = at(a) + at(b);
		state[d] = rotl(at(d) ^ at(a), 8);
		state[c] = at(c) + at(d);
		state[b] = rotl(at(b) ^ at(c), 7);
	};
	for (let round = 0; round < 10; round++) {
		quarter(0, 4, 8, 12);
		quarter(1, 5, 9, 13);
		quarter(2, 6, 10, 14);
		quarter(3, 7, 11, 15);
		quarter(0, 5, 10, 15);
		quarter(1, 6, 11, 12);
		quarter(2, 7, 8, 13);
		quarter(3, 4, 9, 14);
	}

	const subkey = Buffer.alloc(32);
	[0, 1, 2, 3, 12, 13, 14, 15].forEach((word, i) => {
		subkey.writeUInt32LE(at(word), i * 4);
	});
	return subkey;
}

/** XChaCha20-Poly1305 (IETF), opened with OpenSSL's ChaCha20-Poly1305. */
function openXChaCha(ciphertext: Buffer, nonce: Buffer, key: Buffer, aad?: Buffer): Buffer {
	const subkey = hchacha20(key, nonce.subarray(0, 16));
	const iv = Buffer.concat([Buffer.alloc(4), nonce.subarray(16, 24)]);
	const decipher = createDecipheriv("chacha20-poly1305", subkey, iv, { authTagLength: 16 });
	if (aad) {
		decipher.setAAD(aad, { plaintextLength: ciphertext.length - 16 });
	}
	decipher.setAuthTag(ciphertext.subarray(-16));
	return Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
}

// The derivation the vectors record: libsodium's crypto_pwhash, whose limits
// are passes and bytes (OpenSSL takes KiB), over `${password}:${base64url(baseKey)}`.
const ARGON2 = vectors.argon2id[0];

function argon2id(password: string, salt: Buffer, baseKey: Buffer): Buffer {
	if (!ARGON2) throw new Error("no Argon2id vector");
	return argon2Sync("argon2id", {
		message: Buffer.from(`${password}:${baseKey.toString("base64url")}`, "utf8"),
		nonce: salt,
		parallelism: 1,
		tagLength: 32,
		memory: ARGON2.memLimit / 1024,
		passes: ARGON2.opsLimit,
	});
}

const b64 = (value: string): Buffer => Buffer.from(value, "base64");

// Argon2id at libsodium's moderate setting (256 MiB) runs in several test
// files at once.
const ARGON2_TIMEOUT = 30_000;

describe("test vectors, checked by OpenSSL", () => {
	test("HChaCha20 matches its specification", () => {
		const key = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
		const nonce = Buffer.from("000000090000004a0000000031415927", "hex");
		expect(hchacha20(key, nonce).toString("hex")).toBe(
			"82413b4227b27bfed30e42508a877d73a0f9e4d58a74a853c12ec41326d3ecdc",
		);
	});

	test("opens every XChaCha20-Poly1305 vector", () => {
		for (const v of vectors.xchacha20poly1305) {
			const plaintext = openXChaCha(b64(v.ciphertext), b64(v.nonce), b64(v.key));
			expect(plaintext.toString("base64"), v.description).toBe(v.plaintext);
		}
	});

	test("rejects a vector with a flipped bit", () => {
		const v = vectors.xchacha20poly1305[1];
		if (!v) throw new Error("no vector");
		const tampered = b64(v.ciphertext);
		tampered[0] = (tampered[0] ?? 0) ^ 1;
		expect(() => openXChaCha(tampered, b64(v.nonce), b64(v.key))).toThrow();
	});

	test(
		"derives every Argon2id key",
		() => {
			for (const v of vectors.argon2id) {
				expect(v.algorithm).toBe("argon2id13");
				expect(v.baseKeyUrl).toBe(b64(v.baseKey).toString("base64url"));
				expect(v.combinedInput).toBe(`${v.password}:${v.baseKeyUrl}`);
				expect(v.opsLimit).toBe(ARGON2?.opsLimit);
				expect(v.memLimit).toBe(ARGON2?.memLimit);
				const derived = argon2id(v.password, b64(v.salt), b64(v.baseKey));
				expect(derived.toString("base64"), v.description).toBe(v.derivedKey);
			}
		},
		ARGON2_TIMEOUT,
	);

	test(
		"opens every note, password ones included, to its MessagePack payload",
		() => {
			for (const v of vectors.pipeline) {
				let key = b64(v.key);
				if (v.password !== undefined) {
					const derived = argon2id(v.password, b64(v.salt ?? ""), b64(v.baseKey ?? ""));
					expect(derived.equals(key), v.description).toBe(true);
					key = derived;
				}
				const plaintext = openXChaCha(b64(v.ciphertext), b64(v.nonce), key);
				expect(plaintext.toString("base64"), v.description).toBe(v.payloadMsgpack);

				const payload = decode(plaintext) as {
					text?: string;
					contentMode?: string;
					files?: Array<{ name: string; type: string; size: number; data: Uint8Array }>;
				};
				expect(payload.text).toBe(v.payload.text);
				expect(payload.contentMode).toBe(v.payload.contentMode);
				expect(
					payload.files?.map((file) => ({
						...file,
						data: Buffer.from(file.data).toString("base64"),
					})),
				).toEqual(v.payload.files);
			}
		},
		ARGON2_TIMEOUT,
	);

	test("encodes keys as unpadded base64url", () => {
		for (const v of vectors.encoding) {
			expect(b64(v.raw).toString("base64url"), v.description).toBe(v.base64url);
		}
	});

	describe("format 1", () => {
		const { format1 } = vectors;

		/** The key schedule of PROTOCOL.md, in OpenSSL: Argon2id over NFC and the key, then HKDF. */
		function format1Key(
			linkKey: Buffer,
			password?: string,
			argon2?: { salt: string; iterations: number; memoryKiB: number },
		): Buffer {
			let ikm = linkKey;
			if (password !== undefined && argon2) {
				const stretched = argon2Sync("argon2id", {
					message: Buffer.concat([Buffer.from(password.normalize("NFC"), "utf8"), linkKey]),
					nonce: b64(argon2.salt),
					parallelism: 1,
					tagLength: 32,
					memory: argon2.memoryKiB,
					passes: argon2.iterations,
				});
				ikm = Buffer.concat([linkKey, stretched]);
			}
			return Buffer.from(hkdfSync("sha256", ikm, Buffer.alloc(0), "secret/1 enc", 32));
		}

		test(
			"derives every key",
			() => {
				for (const v of format1.keys) {
					const key = format1Key(b64(v.linkKey), v.password, v.argon2);
					expect(key.toString("base64"), v.description).toBe(v.encryptionKey);
					expect(v.keyFragment).toBe(`1.${b64(v.linkKey).toString("base64url")}`);
				}
			},
			ARGON2_TIMEOUT,
		);

		test("lays every envelope out byte by byte", () => {
			for (const v of format1.envelopes) {
				const head = Buffer.alloc(10);
				head.writeUInt8(1, 0);
				head.writeUInt8(v.kind === "single-shot" ? 0 : 1, 1);
				head.writeUInt8(v.argon2 ? 1 : 0, 2);
				head.writeUInt8(v.fileCount, 3);
				head.writeUInt16BE(v.maxReads, 4);
				head.writeUInt32BE(v.expiresIn, 6);
				const params = Buffer.alloc(v.argon2 ? 8 : 0);
				if (v.argon2) {
					params.writeUInt32BE(v.argon2.iterations, 0);
					params.writeUInt32BE(v.argon2.memoryKiB, 4);
				}
				const salt = v.argon2 ? b64(v.argon2.salt) : Buffer.alloc(0);
				expect(Buffer.concat([head, b64(v.nonce), salt, params]).toString("base64")).toBe(
					v.envelope,
				);
			}
		});

		test(
			"opens every single-shot note, the envelope as its additional data",
			() => {
				for (const v of format1.pipeline) {
					const linkKey = Buffer.from(v.keyFragment.slice(2), "base64url");
					const envelope = b64(v.envelope);
					const argon2 =
						envelope[2] === 1
							? {
									salt: envelope.subarray(34, 50).toString("base64"),
									iterations: envelope.readUInt32BE(50),
									memoryKiB: envelope.readUInt32BE(54),
								}
							: undefined;
					const key = format1Key(linkKey, v.password, argon2);
					expect(key.toString("base64"), v.description).toBe(v.encryptionKey);

					const nonce = envelope.subarray(10, 34);
					const plaintext = openXChaCha(b64(v.ciphertext), nonce, key, envelope);
					expect(plaintext.toString("base64"), v.description).toBe(v.payloadMsgpack);

					const altered = Buffer.from(envelope);
					altered.writeUInt16BE(altered.readUInt16BE(4) + 1, 4);
					expect(() => openXChaCha(b64(v.ciphertext), nonce, key, altered)).toThrow();
				}
			},
			ARGON2_TIMEOUT,
		);
	});
});

import {
	argon2Sync,
	createCipheriv,
	createDecipheriv,
	createHash,
	hkdfSync,
	timingSafeEqual,
} from "node:crypto";
import { testVectors } from "@largerio/secret-shared";
import { decode } from "@msgpack/msgpack";
import { describe, expect, test } from "vitest";

/*
 * The committed vectors, checked by a second implementation: OpenSSL, through
 * node:crypto, which shares no code with libsodium. XChaCha20-Poly1305 is
 * HChaCha20 (below, checked against its specification) for the subkey, then
 * OpenSSL's ChaCha20-Poly1305; Argon2id is OpenSSL's. Secretstream is
 * written out below from OpenSSL's ChaCha20, HChaCha20 and a Poly1305 of its
 * own, both checked against RFC 8439. What both agree on is the format,
 * rather than one library's behaviour, and another client can be written
 * against it.
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

/** ChaCha20 (RFC 8439) from block `counter` on: OpenSSL's IV is the counter, little-endian, then the nonce. */
function chacha20(key: Buffer, nonce12: Buffer, counter: number, data: Buffer): Buffer {
	const iv = Buffer.alloc(16);
	iv.writeUInt32LE(counter, 0);
	nonce12.copy(iv, 4);
	return createCipheriv("chacha20", key, iv).update(data);
}

const littleEndian = (bytes: Buffer): bigint =>
	BigInt(`0x${Buffer.from(bytes).reverse().toString("hex") || "0"}`);

/** Poly1305 (RFC 8439, section 2.5), over the whole message at once. */
function poly1305(key: Buffer, message: Buffer): Buffer {
	const p = (1n << 130n) - 5n;
	const r = littleEndian(key.subarray(0, 16)) & 0x0ffffffc0ffffffc0ffffffc0fffffffn;
	const s = littleEndian(key.subarray(16, 32));
	let accumulator = 0n;
	for (let offset = 0; offset < message.length; offset += 16) {
		const block = message.subarray(offset, offset + 16);
		accumulator = ((accumulator + littleEndian(block) + (1n << BigInt(8 * block.length))) * r) % p;
	}
	const tag = (accumulator + s) & ((1n << 128n) - 1n);
	return Buffer.from(tag.toString(16).padStart(32, "0"), "hex").reverse();
}

const u64 = (value: number): Buffer => {
	const bytes = Buffer.alloc(8);
	bytes.writeBigUInt64LE(BigInt(value));
	return bytes;
};

const TAG_MESSAGE = 0;
const TAG_REKEY = 2;
const TAG_FINAL = 3;

/**
 * libsodium's crypto_secretstream_xchacha20poly1305, pulled: a key from
 * HChaCha20 over the header's first 16 bytes, a 12-byte nonce of a counter
 * from 1 and the header's last 8 bytes. Each message is its tag, encrypted as
 * the first byte of ChaCha20's block 1, then its text from block 2, then a
 * Poly1305 tag over the additional data, that block, the text and their
 * lengths; the tag's first 8 bytes are XORed into the nonce, the counter
 * moves on, and a REKEY or FINAL tag rekeys. As libsodium does, the text is
 * padded with `length mod 16` zeros before the lengths, not to 16.
 */
function pullSecretstream(
	key: Buffer,
	header: Buffer,
	messages: ReadonlyArray<Buffer>,
	additionalData: Buffer,
): Array<{ tag: number; text: Buffer }> {
	let streamKey: Buffer = hchacha20(key, header.subarray(0, 16));
	let counter = 1;
	let innerNonce: Buffer = Buffer.from(header.subarray(16, 24));
	const nonce = (): Buffer => {
		const bytes = Buffer.alloc(12);
		bytes.writeUInt32LE(counter, 0);
		innerNonce.copy(bytes, 4);
		return bytes;
	};

	return messages.map((message) => {
		if (message.length < 17) throw new Error("Message too short");
		const textLength = message.length - 17;
		const polyKey = chacha20(streamKey, nonce(), 0, Buffer.alloc(64)).subarray(0, 32);
		const block = chacha20(streamKey, nonce(), 1, Buffer.alloc(64));
		const tag = (block[0] ?? 0) ^ (message[0] ?? 0);
		block[0] = message[0] ?? 0;
		const ciphertext = message.subarray(1, 1 + textLength);
		const mac = poly1305(
			polyKey,
			Buffer.concat([
				additionalData,
				Buffer.alloc((16 - (additionalData.length % 16)) % 16),
				block,
				ciphertext,
				Buffer.alloc(textLength % 16),
				u64(additionalData.length),
				u64(64 + textLength),
			]),
		);
		if (!timingSafeEqual(mac, message.subarray(1 + textLength))) {
			throw new Error("Decryption failed");
		}
		const text = chacha20(streamKey, nonce(), 2, ciphertext);

		for (let i = 0; i < 8; i++) {
			innerNonce[i] = (innerNonce[i] ?? 0) ^ (mac[i] ?? 0);
		}
		counter = (counter + 1) >>> 0;
		if ((tag & TAG_REKEY) !== 0 || counter === 0) {
			const next = chacha20(streamKey, nonce(), 0, Buffer.concat([streamKey, innerNonce]));
			streamKey = next.subarray(0, 32);
			innerNonce = next.subarray(32, 40);
			counter = 1;
		}
		return { tag, text };
	});
}

/** Padmé with a 4096-byte floor (PROTOCOL.md, "The body"), in BigInt. */
function sizeClassOf(length: number): number {
	if (length <= 4096) return 4096;
	const big = BigInt(length);
	const e = BigInt(big.toString(2).length - 1);
	const s = BigInt(e.toString(2).length);
	const step = 1n << (e - s);
	return Number(((big + step - 1n) / step) * step);
}

interface ReadFile {
	readonly name: string;
	readonly type: string;
	readonly size: number;
	readonly data: Buffer;
}

const isMap = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;

/**
 * A format 1 body read as "Reading strictly" says, written from PROTOCOL.md
 * apart from the SDK's reader: the payload, or a throw for whatever a reader
 * must refuse.
 */
function readBody(
	body: Buffer,
	fileCount: number,
): { text?: unknown; contentMode?: unknown; files: ReadFile[] } {
	if (body.length < 4) throw new Error("body shorter than 4 bytes");
	const headEnd = 4 + body.readUInt32BE(0);
	if (headEnd > body.length) throw new Error("head longer than the body");
	const head: unknown = decode(body.subarray(4, headEnd));
	if (!isMap(head)) throw new Error("head not a map");
	if ("text" in head && typeof head["text"] !== "string") throw new Error("text not a string");
	if (
		"contentMode" in head &&
		!["text", "markdown", "secret"].includes(head["contentMode"] as string)
	)
		throw new Error("unknown contentMode");
	const declared = head["files"] ?? [];
	if (!Array.isArray(declared) || declared.length > 10) throw new Error("files not a list of 10");
	if (declared.length !== fileCount) throw new Error("not the envelope's fileCount");

	let offset = headEnd;
	const files = declared.map((file: unknown): ReadFile => {
		if (!isMap(file) || typeof file["name"] !== "string" || typeof file["type"] !== "string")
			throw new Error("file without a name or a type");
		const size = file["size"];
		if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0)
			throw new Error("size not a non-negative integer");
		if (size > body.length - offset) throw new Error("sizes beyond the body");
		const data = body.subarray(offset, offset + size);
		offset += size;
		return { name: file["name"], type: file["type"], size, data };
	});
	if (body.length !== sizeClassOf(offset)) throw new Error("not the size class");
	if (body.subarray(offset).some((byte) => byte !== 0)) throw new Error("padding not zero");
	return {
		...("text" in head ? { text: head["text"] } : {}),
		...("contentMode" in head ? { contentMode: head["contentMode"] } : {}),
		files,
	};
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

	test("ChaCha20 and Poly1305 match RFC 8439", () => {
		// Section 2.4.2: the sunscreen text, from block 1.
		const key = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
		const nonce = Buffer.from("000000000000004a00000000", "hex");
		const sunscreen = Buffer.from(
			"Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.",
		);
		expect(chacha20(key, nonce, 1, sunscreen).subarray(0, 16).toString("hex")).toBe(
			"6e2e359a2568f98041ba0728dd0d6981",
		);
		// Section 2.5.2.
		const polyKey = Buffer.from(
			"85d6be7857556d337f4452fe42d506a80103808afb0db2fd4abff6af4149f51b",
			"hex",
		);
		expect(
			poly1305(polyKey, Buffer.from("Cryptographic Forum Research Group")).toString("hex"),
		).toBe("a8061dc1305136c6c22b8baf0c0127a9");
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

		const hkdf = (ikm: Buffer, info: string) =>
			Buffer.from(hkdfSync("sha256", ikm, Buffer.alloc(0), info, 32));
		const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("base64");

		/** HKDF's input of PROTOCOL.md, in OpenSSL: the key, then Argon2id over NFC and the key. */
		function format1Ikm(
			linkKey: Buffer,
			password?: string,
			argon2?: { salt: string; iterations: number; memoryKiB: number },
		): Buffer {
			if (password === undefined || !argon2) {
				return linkKey;
			}
			const stretched = argon2Sync("argon2id", {
				message: Buffer.concat([Buffer.from(password.normalize("NFC"), "utf8"), linkKey]),
				nonce: b64(argon2.salt),
				parallelism: 1,
				tagLength: 32,
				memory: argon2.memoryKiB,
				passes: argon2.iterations,
			});
			return Buffer.concat([linkKey, stretched]);
		}

		function format1Key(
			linkKey: Buffer,
			password?: string,
			argon2?: { salt: string; iterations: number; memoryKiB: number },
		): Buffer {
			return hkdf(format1Ikm(linkKey, password, argon2), "secret/1 enc");
		}

		test(
			"derives every key, proof and verifier",
			() => {
				for (const v of format1.keys) {
					const linkKey = b64(v.linkKey);
					const ikm = format1Ikm(linkKey, v.password, v.argon2);
					expect(hkdf(ikm, "secret/1 enc").toString("base64"), v.description).toBe(v.encryptionKey);
					expect(v.keyFragment).toBe(`1.${linkKey.toString("base64url")}`);

					const linkProof = hkdf(linkKey, "secret/1 link");
					expect(linkProof.toString("base64"), v.description).toBe(v.linkProof);
					expect(sha256(linkProof), v.description).toBe(v.linkVerifier);
					if (v.password === undefined) {
						expect(v.passwordProof, v.description).toBeUndefined();
						continue;
					}
					const passwordProof = hkdf(ikm, "secret/1 read");
					expect(passwordProof.toString("base64"), v.description).toBe(v.passwordProof);
					expect(sha256(passwordProof), v.description).toBe(v.passwordVerifier);
				}
			},
			ARGON2_TIMEOUT,
		);

		test("lays every envelope out byte by byte", () => {
			for (const v of format1.envelopes) {
				const head = Buffer.alloc(9);
				head.writeUInt8(1, 0);
				head.writeUInt8(v.argon2 ? 1 : 0, 1);
				head.writeUInt8(v.fileCount, 2);
				head.writeUInt16BE(v.maxReads, 3);
				head.writeUInt32BE(v.expiresIn, 5);
				const params = Buffer.alloc(v.argon2 ? 8 : 0);
				if (v.argon2) {
					params.writeUInt32BE(v.argon2.iterations, 0);
					params.writeUInt32BE(v.argon2.memoryKiB, 4);
				}
				const salt = v.argon2 ? b64(v.argon2.salt) : Buffer.alloc(0);
				expect(Buffer.concat([head, b64(v.streamHeader), salt, params]).toString("base64")).toBe(
					v.envelope,
				);
			}
		});

		test("pads to the size classes", () => {
			for (const v of format1.sizeClasses) {
				expect(sizeClassOf(v.length), String(v.length)).toBe(v.sizeClass);
			}
		});

		/** A note's key and its messages pulled, under the envelope the vector gives. */
		function pullNote(v: {
			keyFragment: string;
			password?: string;
			envelope: string;
			messages: ReadonlyArray<string>;
		}) {
			const linkKey = Buffer.from(v.keyFragment.slice(2), "base64url");
			const envelope = b64(v.envelope);
			const argon2 =
				envelope[1] === 1
					? {
							salt: envelope.subarray(33, 49).toString("base64"),
							iterations: envelope.readUInt32BE(49),
							memoryKiB: envelope.readUInt32BE(53),
						}
					: undefined;
			const key = format1Key(linkKey, v.password, argon2);
			const pulled = pullSecretstream(key, envelope.subarray(9, 33), v.messages.map(b64), envelope);
			return { key, envelope, pulled };
		}

		test(
			"opens every note into its body, and reads its payload back",
			() => {
				for (const v of format1.notes) {
					const { key, envelope, pulled } = pullNote(v);
					expect(key.toString("base64"), v.description).toBe(v.encryptionKey);
					expect(
						pulled.map(({ tag }) => tag),
						v.description,
					).toEqual(pulled.map((_, i) => (i === pulled.length - 1 ? TAG_FINAL : TAG_MESSAGE)));
					const body = Buffer.concat(pulled.map(({ text }) => text));
					expect(body.toString("base64"), v.description).toBe(v.body);
					expect(body.subarray(4, 4 + body.readUInt32BE(0)).toString("base64"), v.description).toBe(
						v.head,
					);

					const payload = readBody(body, envelope.readUInt8(2));
					expect(payload.text, v.description).toBe(v.payload.text);
					expect(payload.contentMode, v.description).toBe(v.payload.contentMode);
					expect(
						payload.files.map((file) => ({ ...file, data: file.data.toString("base64") })),
						v.description,
					).toEqual(v.payload.files ?? []);

					const altered = Buffer.from(envelope);
					altered.writeUInt16BE(altered.readUInt16BE(3) + 1, 3);
					expect(() =>
						pullSecretstream(key, envelope.subarray(9, 33), v.messages.map(b64), altered),
					).toThrow();
				}
			},
			ARGON2_TIMEOUT,
		);

		test("refuses every note a reader must refuse", () => {
			for (const v of format1.invalid.notes) {
				expect(() => {
					const { envelope, pulled } = pullNote(v);
					const last = pulled.length - 1;
					if (last < 0) throw new Error("no message");
					pulled.forEach(({ tag }, i) => {
						if (tag !== (i === last ? TAG_FINAL : TAG_MESSAGE)) throw new Error("wrong tag");
					});
					readBody(Buffer.concat(pulled.map(({ text }) => text)), envelope.readUInt8(2));
				}, v.description).toThrow();
			}
		});
	});
});

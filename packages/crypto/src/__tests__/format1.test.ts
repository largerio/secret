import { argon2Sync, createHash, hkdfSync } from "node:crypto";
import sodium from "libsodium-wrappers-sumo";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { decryptChunk, decryptRaw, initStreamDecrypt } from "../decrypt.js";
import { encryptChunk, encryptPayload, initStreamEncrypt } from "../encrypt.js";
import {
	deriveFormat1Keys,
	hkdfExpand,
	hkdfExtract,
	stretchPassword,
	verifierOf,
	zeroFormat1Keys,
} from "../format1.js";
import { generateKey, generateSalt, initSodium } from "../keys.js";

beforeAll(async () => {
	await initSodium();
});

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

// The lightest parameters a format 1 reader runs, to keep the tests quick.
const LIGHT = { iterations: 1, memoryKiB: 65_536 };

describe("HKDF-SHA256", () => {
	// RFC 5869, appendix A.3: no salt, no info.
	it("matches the RFC 5869 test case without salt or info", () => {
		const prk = hkdfExtract(new Uint8Array(22).fill(0x0b));
		expect(hex(prk)).toBe("19ef24a32c717b167f33a91d6f648bdf96596776afdb6377ac434c1c293ccb04");
		expect(hex(hkdfExpand(prk, ""))).toBe(
			"8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d",
		);
	});

	it("agrees with OpenSSL's HKDF, info included", () => {
		const ikm = generateKey();
		const openssl = Buffer.from(hkdfSync("sha256", ikm, new Uint8Array(0), "secret/1 enc", 32));
		expect(hex(hkdfExpand(hkdfExtract(ikm), "secret/1 enc"))).toBe(openssl.toString("hex"));
	});
});

describe("stretchPassword", () => {
	it("runs Argon2id over the UTF-8 of the password then the link's key, as OpenSSL does", () => {
		const salt = generateSalt();
		const linkKey = generateKey();
		const stretched = stretchPassword(
			{ password: "pässwörd", argon2: { salt, ...LIGHT } },
			linkKey,
		);
		const openssl = argon2Sync("argon2id", {
			message: Buffer.concat([Buffer.from("pässwörd".normalize("NFC"), "utf8"), linkKey]),
			nonce: salt,
			parallelism: 1,
			tagLength: 32,
			memory: LIGHT.memoryKiB,
			passes: LIGHT.iterations,
		});
		expect(hex(stretched)).toBe(openssl.toString("hex"));
	});

	it("derives the same bytes from a password typed in NFC or in NFD", () => {
		const argon2 = { salt: generateSalt(), ...LIGHT };
		const linkKey = generateKey();
		const nfc = "café".normalize("NFC");
		const nfd = "café".normalize("NFD");
		expect(nfc).not.toBe(nfd);
		expect(stretchPassword({ password: nfd, argon2 }, linkKey)).toEqual(
			stretchPassword({ password: nfc, argon2 }, linkKey),
		);
	});

	// The salt is stored with the note: without the key in the input, it would
	// be enough to stretch a dictionary before the link is ever seen.
	it("depends on the link's key, not on the password and the salt alone", () => {
		const password = { password: "hunter2", argon2: { salt: generateSalt(), ...LIGHT } };
		expect(stretchPassword(password, generateKey())).not.toEqual(
			stretchPassword(password, generateKey()),
		);
	});

	it("encodes a lone surrogate as U+FFFD, as WHATWG UTF-8 does", () => {
		const argon2 = { salt: generateSalt(), ...LIGHT };
		const linkKey = generateKey();
		expect(stretchPassword({ password: "pw\uD800", argon2 }, linkKey)).toEqual(
			stretchPassword({ password: "pw\uFFFD", argon2 }, linkKey),
		);
	});
});

describe("deriveFormat1Keys", () => {
	const hkdf = (ikm: Uint8Array, info: string) =>
		Buffer.from(hkdfSync("sha256", ikm, new Uint8Array(0), info, 32)).toString("hex");

	it("is HKDF over the link's key alone without a password", () => {
		const linkKey = generateKey();
		const keys = deriveFormat1Keys(linkKey);
		expect(hex(keys.encryptionKey)).toBe(hkdf(linkKey, "secret/1 enc"));
		expect(hex(keys.linkProof)).toBe(hkdf(linkKey, "secret/1 link"));
		expect(keys.passwordProof).toBeUndefined();
	});

	it("is HKDF over the link's key and the stretched password with one", () => {
		const linkKey = generateKey();
		const password = { password: "hunter2", argon2: { salt: generateSalt(), ...LIGHT } };
		const ikm = Buffer.concat([linkKey, stretchPassword(password, linkKey)]);
		const keys = deriveFormat1Keys(linkKey, password);
		expect(hex(keys.encryptionKey)).toBe(hkdf(ikm, "secret/1 enc"));
		expect(keys.passwordProof && hex(keys.passwordProof)).toBe(hkdf(ikm, "secret/1 read"));
	});

	// Whoever has the link but not the password can prove the link, never the password.
	it("proves the link with the link's key alone, password or not", () => {
		const linkKey = generateKey();
		const password = { password: "hunter2", argon2: { salt: generateSalt(), ...LIGHT } };
		expect(deriveFormat1Keys(linkKey, password).linkProof).toEqual(
			deriveFormat1Keys(linkKey).linkProof,
		);
	});

	it("gives three keys apart from each other and from the link's key", () => {
		const linkKey = generateKey();
		const password = { password: "hunter2", argon2: { salt: generateSalt(), ...LIGHT } };
		const keys = deriveFormat1Keys(linkKey, password);
		const all = [linkKey, keys.encryptionKey, keys.linkProof, keys.passwordProof].map((k) =>
			k ? hex(k) : "",
		);
		expect(new Set(all).size).toBe(4);
	});

	/** Records every HMAC-SHA256 output: the PRKs and the keys Expand makes from them. */
	function recordHmacs() {
		const outputs: Uint8Array[] = [];
		const hmac = sodium.crypto_auth_hmacsha256;
		const spy = vi.spyOn(sodium, "crypto_auth_hmacsha256").mockImplementation(((
			message: Uint8Array,
			key: Uint8Array,
		) => {
			const output = hmac(message, key);
			outputs.push(output);
			return output;
		}) as typeof hmac);
		return { outputs, restore: () => spy.mockRestore() };
	}

	// Only Expand's outputs, the keys, may survive: the PRKs go.
	it("wipes the PRKs, the stretched password and HKDF's input", () => {
		const hmacs = recordHmacs();
		const pwhash = sodium.crypto_pwhash;
		let stretched: Uint8Array | undefined;
		const pwhashSpy = vi.spyOn(sodium, "crypto_pwhash").mockImplementation(((
			length: number,
			input: Uint8Array,
			salt: Uint8Array,
			iterations: number,
			memory: number,
			algorithm: number,
		) => {
			stretched = pwhash(length, input, salt, iterations, memory, algorithm);
			return stretched;
		}) as typeof pwhash);
		try {
			const password = { password: "hunter2", argon2: { salt: generateSalt(), ...LIGHT } };
			const keys = deriveFormat1Keys(generateKey(), password);
			const kept: unknown[] = [keys.encryptionKey, keys.linkProof, keys.passwordProof];
			const wiped = hmacs.outputs.filter((output) => !kept.includes(output));

			expect(wiped).toHaveLength(2);
			expect(stretched).toEqual(new Uint8Array(32));
			for (const prk of wiped) {
				expect(prk).toEqual(new Uint8Array(32));
			}
		} finally {
			hmacs.restore();
			pwhashSpy.mockRestore();
		}
	});

	it("wipes the link's PRK when stretching the password fails", () => {
		const hmacs = recordHmacs();
		const pwhashSpy = vi.spyOn(sodium, "crypto_pwhash").mockImplementation(() => {
			throw new Error("out of memory");
		});
		try {
			const password = { password: "hunter2", argon2: { salt: generateSalt(), ...LIGHT } };
			expect(() => deriveFormat1Keys(generateKey(), password)).toThrow("out of memory");
			// The link's PRK alone was made: no key is expanded before the end.
			expect(hmacs.outputs).toEqual([new Uint8Array(32)]);
		} finally {
			hmacs.restore();
			pwhashSpy.mockRestore();
		}
	});

	it("leaves the link's key as it was", () => {
		const linkKey = generateKey();
		const copy = linkKey.slice();
		deriveFormat1Keys(linkKey, { password: "x", argon2: { salt: generateSalt(), ...LIGHT } });
		deriveFormat1Keys(linkKey);
		expect(linkKey).toEqual(copy);
	});
});

describe("zeroFormat1Keys", () => {
	it("wipes every key and proof", () => {
		const password = { password: "x", argon2: { salt: generateSalt(), ...LIGHT } };
		const keys = deriveFormat1Keys(generateKey(), password);
		zeroFormat1Keys(keys);
		for (const key of [keys.encryptionKey, keys.linkProof, keys.passwordProof]) {
			expect(key).toEqual(new Uint8Array(32));
		}
	});

	it("wipes a note's without a password proof", () => {
		const keys = deriveFormat1Keys(generateKey());
		zeroFormat1Keys(keys);
		expect(keys.linkProof).toEqual(new Uint8Array(32));
	});
});

describe("verifierOf", () => {
	it("is the SHA-256 of the proof", () => {
		const proof = generateKey();
		expect(hex(verifierOf(proof))).toBe(createHash("sha256").update(proof).digest("hex"));
	});
});

describe("additional data", () => {
	const ad = new TextEncoder().encode("envelope");

	it("binds a single-shot ciphertext to it", () => {
		const key = generateKey();
		const { ciphertext, nonce } = encryptPayload({ text: "hi" }, key, undefined, ad);
		expect(decryptRaw(ciphertext, nonce, key, ad)).toBeInstanceOf(Uint8Array);
		expect(() =>
			decryptRaw(ciphertext, nonce, key, new TextEncoder().encode("envelopf")),
		).toThrow();
		expect(() => decryptRaw(ciphertext, nonce, key)).toThrow();
	});

	it("uses the nonce it is given", () => {
		const key = generateKey();
		const nonce = sodium.randombytes_buf(24);
		expect(encryptPayload({ text: "hi" }, key, nonce, ad).nonce).toBe(nonce);
	});

	it("binds every chunk of a stream to it", () => {
		const key = generateKey();
		const { state, header } = initStreamEncrypt(key);
		const chunk = encryptChunk(state, new Uint8Array([1, 2, 3]), true, ad);

		const open = (additionalData: Uint8Array | null) =>
			decryptChunk(initStreamDecrypt(header, key), chunk, additionalData);
		expect(open(ad)).toEqual({
			decrypted: new Uint8Array([1, 2, 3]),
			isFinal: true,
			isMessage: false,
		});
		expect(() => open(null)).toThrow("Decryption failed");
	});
});

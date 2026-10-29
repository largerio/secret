import { argon2Sync, hkdfSync } from "node:crypto";
import sodium from "libsodium-wrappers-sumo";
import { beforeAll, describe, expect, it } from "vitest";
import { decryptChunk, decryptRaw, initStreamDecrypt } from "../decrypt.js";
import { encryptChunk, encryptPayload, initStreamEncrypt } from "../encrypt.js";
import { deriveFormat1Key, hkdfExpand, hkdfExtract, stretchPassword } from "../format1.js";
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
	it("runs Argon2id over the UTF-8 of the password, as OpenSSL does", () => {
		const salt = generateSalt();
		const stretched = stretchPassword({ password: "pässwörd", argon2: { salt, ...LIGHT } });
		const openssl = argon2Sync("argon2id", {
			message: Buffer.from("pässwörd".normalize("NFC"), "utf8"),
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
		const nfc = "café".normalize("NFC");
		const nfd = "café".normalize("NFD");
		expect(nfc).not.toBe(nfd);
		expect(stretchPassword({ password: nfd, argon2 })).toEqual(
			stretchPassword({ password: nfc, argon2 }),
		);
	});
});

describe("deriveFormat1Key", () => {
	it("is HKDF over the link's key alone without a password", () => {
		const linkKey = generateKey();
		const expected = hkdfSync("sha256", linkKey, new Uint8Array(0), "secret/1 enc", 32);
		expect(hex(deriveFormat1Key(linkKey))).toBe(Buffer.from(expected).toString("hex"));
	});

	it("is HKDF over the link's key and the stretched password with one", () => {
		const linkKey = generateKey();
		const password = { password: "hunter2", argon2: { salt: generateSalt(), ...LIGHT } };
		const ikm = Buffer.concat([linkKey, stretchPassword(password)]);
		const expected = hkdfSync("sha256", ikm, new Uint8Array(0), "secret/1 enc", 32);
		expect(hex(deriveFormat1Key(linkKey, password))).toBe(Buffer.from(expected).toString("hex"));
	});

	it("leaves the link's key as it was", () => {
		const linkKey = generateKey();
		const copy = linkKey.slice();
		deriveFormat1Key(linkKey, { password: "x", argon2: { salt: generateSalt(), ...LIGHT } });
		deriveFormat1Key(linkKey);
		expect(linkKey).toEqual(copy);
	});

	it("never hands back the link's key itself", () => {
		const linkKey = generateKey();
		expect(deriveFormat1Key(linkKey)).not.toEqual(linkKey);
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
		expect(open(ad)).toEqual({ decrypted: new Uint8Array([1, 2, 3]), isFinal: true });
		expect(() => open(null)).toThrow("Decryption failed");
	});
});

import sodium from "libsodium-wrappers-sumo";
import { beforeAll, describe, expect, it } from "vitest";
import {
	deriveKeyFromPassword,
	fromBase64,
	generateKey,
	generateNonce,
	generateSalt,
	initSodium,
	keyFromBase64Url,
	keyToBase64Url,
	toBase64,
} from "../keys.js";

beforeAll(async () => {
	await initSodium();
});

describe("generateKey", () => {
	it("generates a 32-byte key", () => {
		const key = generateKey();
		expect(key).toBeInstanceOf(Uint8Array);
		expect(key.length).toBe(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES);
	});

	it("generates unique keys", () => {
		const key1 = generateKey();
		const key2 = generateKey();
		expect(key1).not.toEqual(key2);
	});
});

describe("generateNonce", () => {
	it("generates a 24-byte nonce", () => {
		const nonce = generateNonce();
		expect(nonce).toBeInstanceOf(Uint8Array);
		expect(nonce.length).toBe(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
	});

	it("generates unique nonces", () => {
		const nonce1 = generateNonce();
		const nonce2 = generateNonce();
		expect(nonce1).not.toEqual(nonce2);
	});
});

describe("generateSalt", () => {
	it("generates a salt with correct length", () => {
		const salt = generateSalt();
		expect(salt).toBeInstanceOf(Uint8Array);
		expect(salt.length).toBe(sodium.crypto_pwhash_SALTBYTES);
	});

	it("generates unique salts", () => {
		const salt1 = generateSalt();
		const salt2 = generateSalt();
		expect(salt1).not.toEqual(salt2);
	});
});

describe("deriveKeyFromPassword", () => {
	it("derives a 32-byte key", () => {
		const salt = generateSalt();
		const baseKey = generateKey();
		const derived = deriveKeyFromPassword("testpassword", salt, baseKey);
		expect(derived).toBeInstanceOf(Uint8Array);
		expect(derived.length).toBe(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES);
	});

	it("produces the same key for the same inputs", () => {
		const salt = generateSalt();
		const baseKey = generateKey();
		const key1 = deriveKeyFromPassword("password", salt, baseKey);
		const key2 = deriveKeyFromPassword("password", salt, baseKey);
		expect(key1).toEqual(key2);
	});

	it("produces different keys for different passwords", () => {
		const salt = generateSalt();
		const baseKey = generateKey();
		const key1 = deriveKeyFromPassword("password1", salt, baseKey);
		const key2 = deriveKeyFromPassword("password2", salt, baseKey);
		expect(key1).not.toEqual(key2);
	});

	it("produces different keys for different salts", () => {
		const salt1 = generateSalt();
		const salt2 = generateSalt();
		const baseKey = generateKey();
		const key1 = deriveKeyFromPassword("password", salt1, baseKey);
		const key2 = deriveKeyFromPassword("password", salt2, baseKey);
		expect(key1).not.toEqual(key2);
	});
});

describe("keyToBase64Url / keyFromBase64Url", () => {
	it("roundtrips a key through base64url encoding", () => {
		const key = generateKey();
		const encoded = keyToBase64Url(key);
		const decoded = keyFromBase64Url(encoded);
		expect(decoded).toEqual(key);
	});

	it("produces URL-safe characters", () => {
		const key = generateKey();
		const encoded = keyToBase64Url(key);
		expect(encoded).not.toContain("+");
		expect(encoded).not.toContain("/");
		expect(encoded).not.toContain("=");
	});
});

describe("toBase64 / fromBase64", () => {
	it("roundtrips data through base64 encoding", () => {
		const data = new Uint8Array([1, 2, 3, 4, 5, 255, 0, 128]);
		const encoded = toBase64(data);
		const decoded = fromBase64(encoded);
		expect(decoded).toEqual(data);
	});

	it("produces a non-empty string for non-empty data", () => {
		const data = new Uint8Array([42]);
		const encoded = toBase64(data);
		expect(encoded.length).toBeGreaterThan(0);
	});
});

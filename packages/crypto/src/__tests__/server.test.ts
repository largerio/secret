import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateServerKey, parseServerKey, serverDecrypt, serverEncrypt } from "../server.js";

describe("serverEncrypt / serverDecrypt", () => {
	const serverKey = randomBytes(32);

	it("roundtrips data", () => {
		const data = new Uint8Array([1, 2, 3, 4, 5]);
		const { encrypted, iv } = serverEncrypt(data, serverKey);
		const decrypted = serverDecrypt(encrypted, iv, serverKey);
		expect(new Uint8Array(decrypted)).toEqual(data);
	});

	it("fails decryption with wrong key", () => {
		const data = new Uint8Array([42]);
		const { encrypted, iv } = serverEncrypt(data, serverKey);
		const wrongKey = randomBytes(32);
		expect(() => serverDecrypt(encrypted, iv, wrongKey)).toThrow();
	});

	it("produces different ciphertexts for the same data", () => {
		const data = new Uint8Array([1, 2, 3]);
		const result1 = serverEncrypt(data, serverKey);
		const result2 = serverEncrypt(data, serverKey);
		expect(result1.encrypted).not.toEqual(result2.encrypted);
		expect(result1.iv).not.toEqual(result2.iv);
	});

	it("handles empty data", () => {
		const data = new Uint8Array(0);
		const { encrypted, iv } = serverEncrypt(data, serverKey);
		const decrypted = serverDecrypt(encrypted, iv, serverKey);
		expect(new Uint8Array(decrypted)).toEqual(data);
	});

	it("handles large data", { timeout: 15_000 }, () => {
		const data = new Uint8Array(1024 * 1024);
		data.fill(42);
		const { encrypted, iv } = serverEncrypt(data, serverKey);
		const decrypted = serverDecrypt(encrypted, iv, serverKey);
		expect(new Uint8Array(decrypted)).toEqual(data);
	});

	it("throws on data too short for auth tag", () => {
		const iv = randomBytes(12);
		const tooShort = Buffer.from([1, 2, 3]);
		expect(() => serverDecrypt(tooShort, iv, serverKey)).toThrow("too short for auth tag");
	});

	it("roundtrips data bound to matching AAD", () => {
		const data = new Uint8Array([1, 2, 3, 4, 5]);
		const aad = Buffer.from("note-id-123");
		const { encrypted, iv } = serverEncrypt(data, serverKey, aad);
		const decrypted = serverDecrypt(encrypted, iv, serverKey, aad);
		expect(new Uint8Array(decrypted)).toEqual(data);
	});

	it("fails decryption when AAD does not match", () => {
		const data = new Uint8Array([1, 2, 3]);
		const { encrypted, iv } = serverEncrypt(data, serverKey, Buffer.from("note-a"));
		expect(() => serverDecrypt(encrypted, iv, serverKey, Buffer.from("note-b"))).toThrow();
	});

	it("fails decryption when AAD is missing but was used to encrypt", () => {
		const data = new Uint8Array([1, 2, 3]);
		const { encrypted, iv } = serverEncrypt(data, serverKey, Buffer.from("note-a"));
		expect(() => serverDecrypt(encrypted, iv, serverKey)).toThrow();
	});

	it("fails decryption when AAD is supplied but was not used to encrypt", () => {
		const data = new Uint8Array([1, 2, 3]);
		const { encrypted, iv } = serverEncrypt(data, serverKey);
		expect(() => serverDecrypt(encrypted, iv, serverKey, Buffer.from("note-a"))).toThrow();
	});
});

describe("parseServerKey", () => {
	it("parses a valid 32-byte base64 key", () => {
		const raw = randomBytes(32);
		const base64 = raw.toString("base64");
		const parsed = parseServerKey(base64);
		expect(parsed).toEqual(raw);
	});

	it("throws for a key that is too short", () => {
		const short = randomBytes(16).toString("base64");
		expect(() => parseServerKey(short)).toThrow("must be 32 bytes");
	});

	it("throws for a key that is too long", () => {
		const long = randomBytes(64).toString("base64");
		expect(() => parseServerKey(long)).toThrow("must be 32 bytes");
	});
});

describe("generateServerKey", () => {
	it("generates a valid base64 string", () => {
		const key = generateServerKey();
		expect(typeof key).toBe("string");
		const decoded = Buffer.from(key, "base64");
		expect(decoded.length).toBe(32);
	});

	it("generates unique keys", () => {
		const key1 = generateServerKey();
		const key2 = generateServerKey();
		expect(key1).not.toBe(key2);
	});
});

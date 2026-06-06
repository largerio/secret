import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

// `aad` (additional authenticated data) is authenticated but not encrypted. We
// bind each stored blob to its note id so a blob encrypted under the shared
// server key cannot be relocated to a different note row: decryption with a
// mismatched id fails the GCM auth tag. Must match between encrypt and decrypt.
export function serverEncrypt(
	data: Uint8Array,
	serverKey: Buffer,
	aad?: Uint8Array,
): { encrypted: Buffer; iv: Buffer } {
	const iv = randomBytes(IV_LENGTH);
	const cipher = createCipheriv(ALGORITHM, serverKey, iv);
	if (aad) {
		cipher.setAAD(aad);
	}
	const encrypted = Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()]);
	return { encrypted, iv };
}

export function serverDecrypt(
	encrypted: Buffer,
	iv: Buffer,
	serverKey: Buffer,
	aad?: Uint8Array,
): Buffer {
	if (encrypted.length < AUTH_TAG_LENGTH) {
		throw new Error("Invalid encrypted data: too short for auth tag");
	}
	const authTag = encrypted.subarray(encrypted.length - AUTH_TAG_LENGTH);
	const ciphertext = encrypted.subarray(0, encrypted.length - AUTH_TAG_LENGTH);
	const decipher = createDecipheriv(ALGORITHM, serverKey, iv);
	if (aad) {
		decipher.setAAD(aad);
	}
	decipher.setAuthTag(authTag);
	return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function parseServerKey(base64Key: string): Buffer {
	const key = Buffer.from(base64Key, "base64");
	if (key.length !== 32) {
		throw new Error("SERVER_ENCRYPTION_KEY must be 32 bytes (256 bits) encoded in base64");
	}
	return key;
}

export function generateServerKey(): string {
	return randomBytes(32).toString("base64");
}

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

export function serverEncrypt(data: Uint8Array, serverKey: Buffer): { encrypted: Buffer; iv: Buffer } {
	const iv = randomBytes(IV_LENGTH);
	const cipher = createCipheriv(ALGORITHM, serverKey, iv);
	const encrypted = Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()]);
	return { encrypted, iv };
}

export function serverDecrypt(encrypted: Buffer, iv: Buffer, serverKey: Buffer): Buffer {
	const authTag = encrypted.subarray(encrypted.length - AUTH_TAG_LENGTH);
	const ciphertext = encrypted.subarray(0, encrypted.length - AUTH_TAG_LENGTH);
	const decipher = createDecipheriv(ALGORITHM, serverKey, iv);
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

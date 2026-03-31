import sodium from "libsodium-wrappers-sumo";

export async function initSodium(): Promise<void> {
	await sodium.ready;
}

export function generateKey(): Uint8Array {
	return sodium.crypto_aead_xchacha20poly1305_ietf_keygen();
}

export function generateNonce(): Uint8Array {
	return sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
}

export function generateSalt(): Uint8Array {
	return sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
}

export function deriveKeyFromPassword(
	password: string,
	salt: Uint8Array,
	baseKey: Uint8Array,
): Uint8Array {
	const combined = `${password}:${sodium.to_base64(baseKey, sodium.base64_variants.URLSAFE_NO_PADDING)}`;
	return sodium.crypto_pwhash(
		sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES,
		combined,
		salt,
		sodium.crypto_pwhash_OPSLIMIT_MODERATE,
		sodium.crypto_pwhash_MEMLIMIT_MODERATE,
		sodium.crypto_pwhash_ALG_ARGON2ID13,
	);
}

export function keyToBase64Url(key: Uint8Array): string {
	return sodium.to_base64(key, sodium.base64_variants.URLSAFE_NO_PADDING);
}

export function keyFromBase64Url(encoded: string): Uint8Array {
	return sodium.from_base64(encoded, sodium.base64_variants.URLSAFE_NO_PADDING);
}

export function toBase64(data: Uint8Array): string {
	return sodium.to_base64(data, sodium.base64_variants.ORIGINAL);
}

export function fromBase64(encoded: string): Uint8Array {
	return sodium.from_base64(encoded, sodium.base64_variants.ORIGINAL);
}

export function zeroMemory(buf: Uint8Array): void {
	sodium.memzero(buf);
}

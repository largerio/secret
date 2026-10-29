import type { Argon2Params } from "@largerio/secret-shared";
import sodium from "libsodium-wrappers-sumo";

const KEY_LENGTH = 32;
// RFC 5869: without a salt, HKDF-Extract keys its HMAC with HashLen zero bytes.
const NO_SALT = new Uint8Array(KEY_LENGTH);
const ENCRYPTION_INFO = "secret/1 enc";

/** HKDF-Extract (RFC 5869) with SHA-256 and no salt. */
export function hkdfExtract(ikm: Uint8Array): Uint8Array {
	return sodium.crypto_auth_hmacsha256(ikm, NO_SALT);
}

/**
 * HKDF-Expand (RFC 5869) with SHA-256, for 32 bytes: one HMAC block. The
 * libsodium wrappers expose HMAC-SHA256, not HKDF.
 */
export function hkdfExpand(prk: Uint8Array, info: string): Uint8Array {
	const infoBytes = new TextEncoder().encode(info);
	const block = new Uint8Array(infoBytes.length + 1);
	block.set(infoBytes);
	block[infoBytes.length] = 1;
	return sodium.crypto_auth_hmacsha256(block, prk);
}

/** What a password note's key takes besides the link's key. */
export interface PasswordInput {
	readonly password: string;
	readonly argon2: Argon2Params;
}

/**
 * Argon2id over the password, normalized to NFC so that every input method
 * agrees, followed by the link's key: without the link, the salt alone gives
 * nothing to precompute a dictionary with. TextEncoder turns a lone surrogate
 * into U+FFFD, as WHATWG UTF-8 does.
 */
export function stretchPassword(
	{ password, argon2 }: PasswordInput,
	linkKey: Uint8Array,
): Uint8Array {
	const passwordBytes = new TextEncoder().encode(password.normalize("NFC"));
	const input = new Uint8Array(passwordBytes.length + linkKey.length);
	input.set(passwordBytes);
	input.set(linkKey, passwordBytes.length);
	try {
		return sodium.crypto_pwhash(
			KEY_LENGTH,
			input,
			argon2.salt,
			argon2.iterations,
			argon2.memoryKiB * 1024,
			sodium.crypto_pwhash_ALG_ARGON2ID13,
		);
	} finally {
		sodium.memzero(passwordBytes);
		sodium.memzero(input);
	}
}

/**
 * The key a format 1 note is encrypted with (PROTOCOL.md): HKDF over the link's
 * key, followed for a password note by its stretched password.
 */
export function deriveFormat1Key(linkKey: Uint8Array, password?: PasswordInput): Uint8Array {
	let ikm = linkKey;
	if (password) {
		const stretched = stretchPassword(password, linkKey);
		ikm = new Uint8Array(linkKey.length + stretched.length);
		ikm.set(linkKey);
		ikm.set(stretched, linkKey.length);
		sodium.memzero(stretched);
	}
	const prk = hkdfExtract(ikm);
	try {
		return hkdfExpand(prk, ENCRYPTION_INFO);
	} finally {
		sodium.memzero(prk);
		if (ikm !== linkKey) {
			sodium.memzero(ikm);
		}
	}
}

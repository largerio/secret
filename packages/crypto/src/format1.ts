import type { Argon2Params } from "@largerio/secret-shared";
import sodium from "libsodium-wrappers-sumo";

const KEY_LENGTH = 32;
// RFC 5869: without a salt, HKDF-Extract keys its HMAC with HashLen zero bytes.
const NO_SALT = new Uint8Array(KEY_LENGTH);
const ENCRYPTION_INFO = "secret/1 enc";
const LINK_PROOF_INFO = "secret/1 link";
const PASSWORD_PROOF_INFO = "secret/1 read";

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
 * What a format 1 note's link and password give (PROTOCOL.md): the key it is
 * encrypted with, and the proofs a reader sends before the server serves it.
 */
export interface Format1Keys {
	readonly encryptionKey: Uint8Array;
	/** Proves the link: HKDF over the link's key alone. */
	readonly linkProof: Uint8Array;
	/** A password note's: proves the password, from the same secret as the key. */
	readonly passwordProof?: Uint8Array | undefined;
}

/**
 * A format 1 note's keys and proofs, in one pass of Argon2id: HKDF over the
 * link's key, followed for a password note by its stretched password.
 */
export function deriveFormat1Keys(linkKey: Uint8Array, password?: PasswordInput): Format1Keys {
	// Every intermediate secret is wiped on the way out, a throw included: an
	// Argon2id run the reader cannot allocate memory for is a real failure.
	const secrets: Uint8Array[] = [];
	const kept = <T extends Uint8Array>(secret: T): T => {
		secrets.push(secret);
		return secret;
	};
	try {
		// The keys are expanded last, in the return: a throw before leaves none.
		const linkPrk = kept(hkdfExtract(linkKey));
		if (!password) {
			return {
				encryptionKey: hkdfExpand(linkPrk, ENCRYPTION_INFO),
				linkProof: hkdfExpand(linkPrk, LINK_PROOF_INFO),
			};
		}

		const stretched = kept(stretchPassword(password, linkKey));
		const ikm = kept(new Uint8Array(linkKey.length + stretched.length));
		ikm.set(linkKey);
		ikm.set(stretched, linkKey.length);
		const prk = kept(hkdfExtract(ikm));
		return {
			encryptionKey: hkdfExpand(prk, ENCRYPTION_INFO),
			linkProof: hkdfExpand(linkPrk, LINK_PROOF_INFO),
			passwordProof: hkdfExpand(prk, PASSWORD_PROOF_INFO),
		};
	} finally {
		for (const secret of secrets) {
			sodium.memzero(secret);
		}
	}
}

/** Wipes a note's keys and proofs once they are no longer needed. */
export function zeroFormat1Keys(keys: Format1Keys): void {
	sodium.memzero(keys.encryptionKey);
	sodium.memzero(keys.linkProof);
	if (keys.passwordProof) {
		sodium.memzero(keys.passwordProof);
	}
}

/**
 * What a writer sends the server for a proof: its SHA-256. The server keeps
 * it to check the proof a reader sends, and never serves it.
 */
export function verifierOf(proof: Uint8Array): Uint8Array {
	return sodium.crypto_hash_sha256(proof);
}

import sodium from "libsodium-wrappers-sumo";
import { encode } from "@msgpack/msgpack";
import type { NotePayload } from "@secret/shared";
import { generateNonce } from "./keys.js";

export interface EncryptedNote {
	readonly ciphertext: Uint8Array;
	readonly nonce: Uint8Array;
}

export function encryptPayload(payload: NotePayload, key: Uint8Array): EncryptedNote {
	const encoded = encode(payload);
	const nonce = generateNonce();
	const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
		encoded,
		null,
		null,
		nonce,
		key,
	);
	return { ciphertext, nonce };
}

export function encryptRaw(data: Uint8Array, key: Uint8Array): EncryptedNote {
	const nonce = generateNonce();
	const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
		data,
		null,
		null,
		nonce,
		key,
	);
	return { ciphertext, nonce };
}

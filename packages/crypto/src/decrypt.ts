import sodium from "libsodium-wrappers-sumo";
import { decode } from "@msgpack/msgpack";
import type { NotePayload } from "@secret/shared";

export function decryptPayload(
	ciphertext: Uint8Array,
	nonce: Uint8Array,
	key: Uint8Array,
): NotePayload {
	const decrypted = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
		null,
		ciphertext,
		null,
		nonce,
		key,
	);
	return decode(decrypted) as NotePayload;
}

export function decryptRaw(
	ciphertext: Uint8Array,
	nonce: Uint8Array,
	key: Uint8Array,
): Uint8Array {
	return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
		null,
		ciphertext,
		null,
		nonce,
		key,
	);
}

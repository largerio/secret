import type { NotePayload } from "@largerio/secret-shared";
import { encode } from "@msgpack/msgpack";
import sodium from "libsodium-wrappers-sumo";
import { generateNonce } from "./keys.js";

export interface EncryptedNote {
	readonly ciphertext: Uint8Array;
	readonly nonce: Uint8Array;
}

export function encodeRaw(data: unknown): Uint8Array {
	return encode(data);
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

// --- Streaming encryption (secretstream) ---

export interface StreamEncryptState {
	readonly state: import("libsodium-wrappers-sumo").StateAddress;
	readonly header: Uint8Array;
}

export function initStreamEncrypt(key: Uint8Array): StreamEncryptState {
	const { state, header } = sodium.crypto_secretstream_xchacha20poly1305_init_push(key);
	return { state, header };
}

export function encryptChunk(
	state: import("libsodium-wrappers-sumo").StateAddress,
	chunk: Uint8Array,
	isFinal: boolean,
): Uint8Array {
	const tag = isFinal
		? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL
		: sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
	return sodium.crypto_secretstream_xchacha20poly1305_push(state, chunk, null, tag);
}

// Hardcoded values matching libsodium — verified at init time in keys.ts
export const SECRETSTREAM_ABYTES = 17;
export const SECRETSTREAM_HEADERBYTES = 24;

export function encodePayload(payload: NotePayload): Uint8Array {
	return encode(payload);
}

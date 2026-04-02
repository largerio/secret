import { decode } from "@msgpack/msgpack";
import type { NotePayload } from "@secret/shared";
import sodium from "libsodium-wrappers-sumo";

function isNotePayload(value: unknown): value is NotePayload {
	if (typeof value !== "object" || value === null) return false;
	const obj = value as Record<string, unknown>;
	if (obj["text"] !== undefined && typeof obj["text"] !== "string") return false;
	if (obj["files"] !== undefined && !Array.isArray(obj["files"])) return false;
	return true;
}

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
	const decoded = decode(decrypted);
	if (!isNotePayload(decoded)) {
		throw new Error("Invalid payload structure after decryption");
	}
	return decoded;
}

export function decryptRaw(ciphertext: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array {
	return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ciphertext, null, nonce, key);
}

// --- Streaming decryption (secretstream) ---

export function initStreamDecrypt(
	header: Uint8Array,
	key: Uint8Array,
): import("libsodium-wrappers-sumo").StateAddress {
	return sodium.crypto_secretstream_xchacha20poly1305_init_pull(header, key);
}

export interface DecryptChunkResult {
	readonly decrypted: Uint8Array;
	readonly isFinal: boolean;
}

export function decryptChunk(
	state: import("libsodium-wrappers-sumo").StateAddress,
	encryptedChunk: Uint8Array,
): DecryptChunkResult {
	const result = sodium.crypto_secretstream_xchacha20poly1305_pull(state, encryptedChunk, null);
	if (!result) {
		throw new Error("Failed to decrypt chunk: invalid or corrupted data");
	}
	return {
		decrypted: result.message,
		isFinal: result.tag === sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL,
	};
}

export function decodePayloadBytes(data: Uint8Array): NotePayload {
	const decoded = decode(data);
	if (!isNotePayload(decoded)) {
		throw new Error("Invalid payload structure after decryption");
	}
	return decoded;
}

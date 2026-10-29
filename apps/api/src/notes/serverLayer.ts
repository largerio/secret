import { serverDecrypt, serverEncrypt } from "@largerio/secret-crypto/server";

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * The server's own encryption layer over the client's ciphertext: AES-256-GCM
 * under the instance key, the note id as additional data, so that bytes moved
 * to another note fail to open. Two layouts, which the notes already stored
 * keep: a single-shot note holds its IV in its row (`server_nonce`), a chunk
 * carries its IV in front of it.
 */
export interface ServerLayer {
	/** Seals a single-shot note's ciphertext; its IV goes in the note's row. */
	sealSingleShot(
		noteId: string,
		ciphertext: Buffer,
	): { readonly sealed: Buffer; readonly iv: Buffer };
	openSingleShot(noteId: string, sealed: Buffer, iv: Buffer): Buffer;
	/** Seals one chunk of a chunked note, its IV in front. */
	sealChunk(noteId: string, chunk: Buffer): Buffer;
	openChunk(noteId: string, stored: Buffer): Buffer;
}

export function createServerLayer(serverKey: Buffer): ServerLayer {
	return {
		sealSingleShot(noteId, ciphertext) {
			const { encrypted, iv } = serverEncrypt(ciphertext, serverKey, Buffer.from(noteId));
			return { sealed: encrypted, iv };
		},

		openSingleShot(noteId, sealed, iv) {
			return serverDecrypt(sealed, iv, serverKey, Buffer.from(noteId));
		},

		sealChunk(noteId, chunk) {
			const { encrypted, iv } = serverEncrypt(chunk, serverKey, Buffer.from(noteId));
			return Buffer.concat([iv, encrypted]);
		},

		openChunk(noteId, stored) {
			const iv = stored.subarray(0, IV_LENGTH);
			const sealed = stored.subarray(IV_LENGTH);
			if (sealed.length < AUTH_TAG_LENGTH) {
				throw new Error("Invalid chunk data");
			}
			return serverDecrypt(sealed, iv, serverKey, Buffer.from(noteId));
		},
	};
}

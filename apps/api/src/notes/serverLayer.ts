import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { serverDecrypt, serverEncrypt } from "@largerio/secret-crypto/server";
import type { ReadVerifiers, SealedVerifier, SealedVerifiers } from "./types.js";

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

// The key verifiers are sealed under, derived from the instance key (PROTOCOL.md,
// "Server layer") so that the AES key is not an HMAC key as well.
const VERIFIER_KEY_INFO = "secret/server verifier";
const VERIFIER_KEY_LENGTH = 32;

/**
 * The server's own encryption layer over the client's ciphertext: AES-256-GCM
 * under the instance key, the note id as additional data, so that bytes moved
 * to another note fail to open. Two layouts, which the notes already stored
 * keep: a single-shot note holds its IV in its row (`server_nonce`), a chunk
 * carries its IV in front of it.
 *
 * It also seals a format 1 note's verifiers, so that a copy of the database
 * without the instance key gives nothing to test passwords against.
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
	/** A writer's verifiers as the note's row keeps them, bound to its id. */
	sealVerifiers(noteId: string, verifiers: ReadVerifiers): SealedVerifiers;
	/** Whether a reader's proof is the one the sealed verifier was made from. */
	proves(noteId: string, proof: Uint8Array, verifier: SealedVerifier): boolean;
}

export function createServerLayer(serverKey: Buffer): ServerLayer {
	// Derived once: HKDF-SHA256 without a salt, which RFC 5869 reads as HashLen
	// zero bytes, as an empty HMAC key is.
	const verifierKey = Buffer.from(
		hkdfSync("sha256", serverKey, Buffer.alloc(0), VERIFIER_KEY_INFO, VERIFIER_KEY_LENGTH),
	);

	/** HMAC-SHA256 over the note's id, then the verifier: copied to another note, it fails. */
	function seal(noteId: string, verifier: Uint8Array): SealedVerifier {
		return createHmac("sha256", verifierKey)
			.update(Buffer.from(noteId))
			.update(verifier)
			.digest() as SealedVerifier;
	}

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

		sealVerifiers(noteId, verifiers) {
			return {
				link: seal(noteId, verifiers.link),
				...(verifiers.password ? { password: seal(noteId, verifiers.password) } : {}),
			};
		},

		proves(noteId, proof, verifier) {
			// The verifier a writer sends is the proof's SHA-256. Both sides are
			// HMAC-SHA256 outputs: timingSafeEqual, which throws on a length
			// mismatch, would only throw on a corrupt row, refused as the error it is.
			const verifierOfProof = createHash("sha256").update(proof).digest();
			return timingSafeEqual(seal(noteId, verifierOfProof), verifier);
		},
	};
}

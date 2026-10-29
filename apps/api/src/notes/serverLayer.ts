import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { serverDecrypt, serverEncrypt } from "@largerio/secret-crypto/server";
import type { ReadVerifiers, SealedVerifier, SealedVerifiers, VerifierRole } from "./types.js";

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

// The key verifiers are sealed under, derived from the instance key (PROTOCOL.md,
// "Server layer") so that the AES key is not an HMAC key as well.
const VERIFIER_KEY_INFO = "secret/server verifier";
const VERIFIER_KEY_LENGTH = 32;

/** A sealed verifier's length: an HMAC-SHA256 output. */
export const SEALED_VERIFIER_LENGTH = 32;

// Ends the role, so that no role followed by an id reads as another role.
const ROLE_END = Buffer.from([0]);

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
	/**
	 * A writer's verifiers as the note's row keeps them, each bound to its role,
	 * to the note's id and to its envelope.
	 */
	sealVerifiers(noteId: string, envelope: Buffer, verifiers: ReadVerifiers): SealedVerifiers;
	/**
	 * Whether a reader's proof is the one the verifier was made from, sealed for
	 * this role, this note and this envelope.
	 */
	proves(
		noteId: string,
		envelope: Buffer,
		role: VerifierRole,
		proof: Uint8Array,
		sealed: SealedVerifier,
	): boolean;
}

export function createServerLayer(serverKey: Buffer): ServerLayer {
	// Derived once: HKDF-SHA256 without a salt, which RFC 5869 reads as HashLen
	// zero bytes, as an empty HMAC key is.
	const verifierKey = Buffer.from(
		hkdfSync("sha256", serverKey, Buffer.alloc(0), VERIFIER_KEY_INFO, VERIFIER_KEY_LENGTH),
	);

	/**
	 * HMAC-SHA256 over the verifier's role, a zero byte, the note's id, the
	 * envelope's SHA-256, then the verifier. Whoever can write to the database
	 * but lacks the key can neither move a verifier to another note, nor make the
	 * link's stand for the password's, nor rewrite the envelope (to one without a
	 * password, say) and keep its verifiers: each then fails its check.
	 */
	function seal(
		role: VerifierRole,
		noteId: string,
		envelope: Buffer,
		verifier: Uint8Array,
	): SealedVerifier {
		return createHmac("sha256", verifierKey)
			.update(Buffer.from(role))
			.update(ROLE_END)
			.update(Buffer.from(noteId))
			.update(createHash("sha256").update(envelope).digest())
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

		sealVerifiers(noteId, envelope, verifiers) {
			return {
				link: seal("link", noteId, envelope, verifiers.link),
				...(verifiers.password
					? { password: seal("password", noteId, envelope, verifiers.password) }
					: {}),
			};
		},

		proves(noteId, envelope, role, proof, sealed) {
			// The verifier a writer sends is the proof's SHA-256. timingSafeEqual
			// throws on a length mismatch: a stored verifier of another length than
			// an HMAC-SHA256 output never gets here, format1ReadingOf refusing its
			// row as corrupt.
			const verifierOfProof = createHash("sha256").update(proof).digest();
			return timingSafeEqual(seal(role, noteId, envelope, verifierOfProof), sealed);
		},
	};
}

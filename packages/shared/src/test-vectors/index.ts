import vectors from "./vectors.json" with { type: "json" };

export interface XChaCha20Vector {
	readonly description: string;
	readonly key: string;
	readonly nonce: string;
	readonly plaintext: string;
	readonly ciphertext: string;
}

export interface Argon2idVector {
	readonly description: string;
	readonly password: string;
	readonly salt: string;
	readonly baseKey: string;
	readonly baseKeyUrl: string;
	readonly combinedInput: string;
	readonly opsLimit: number;
	readonly memLimit: number;
	readonly algorithm: string;
	readonly derivedKey: string;
}

export interface PipelineFileVector {
	readonly name: string;
	readonly type: string;
	readonly size: number;
	readonly data: string;
}

export interface PipelineVector {
	readonly description: string;
	readonly payload: {
		readonly text: string;
		readonly contentMode: string;
		readonly files?: ReadonlyArray<PipelineFileVector>;
	};
	readonly payloadMsgpack: string;
	/** The XChaCha20 key the ciphertext was sealed with (the derived key when password-protected). */
	readonly key: string;
	readonly nonce: string;
	readonly ciphertext: string;
	/** Present for password-protected notes: `key` must equal Argon2id(password, salt, baseKey). */
	readonly password?: string;
	readonly salt?: string;
	readonly baseKey?: string;
}

/** A chunked note: one secretstream, written once since its header is random. */
export interface SecretstreamVector {
	readonly description: string;
	/** The stream key, the bytes of `keyFragment` (no password). */
	readonly key: string;
	readonly keyFragment: string;
	readonly chunkSize: number;
	readonly payload: PipelineVector["payload"];
	/** The first chunk's plaintext: text and file metadata, no file bytes. */
	readonly headerMsgpack: string;
	readonly header: string;
	readonly chunks: ReadonlyArray<string>;
}

/** Argon2id parameters as a format 1 envelope stores them. */
export interface Format1Argon2Vector {
	readonly salt: string;
	readonly iterations: number;
	readonly memoryKiB: number;
}

/** Format 1's key schedule, from the link's key (and a password) to the encryption key. */
export interface Format1KeyVector {
	readonly description: string;
	readonly linkKey: string;
	readonly keyFragment: string;
	/** As typed: possibly not in NFC, which the derivation normalizes to. */
	readonly password?: string;
	readonly argon2?: Format1Argon2Vector;
	/** Argon2id over the UTF-8 of the password in NFC, followed by the link's key. */
	readonly stretchedPassword?: string;
	/** HKDF-Extract, without salt, over the link's key and the stretched password. */
	readonly prk: string;
	/** HKDF-Expand of the PRK with the info `secret/1 enc`. */
	readonly encryptionKey: string;
	/** HKDF over the link's key alone, with the info `secret/1 link`. */
	readonly linkProof: string;
	/** SHA-256 of the link proof. */
	readonly linkVerifier: string;
	/** A password note's: HKDF-Expand of the PRK with the info `secret/1 read`. */
	readonly passwordProof?: string;
	/** SHA-256 of the password proof. */
	readonly passwordVerifier?: string;
}

export interface Format1EnvelopeVector {
	readonly description: string;
	readonly kind: "single-shot" | "chunked";
	readonly fileCount: number;
	readonly maxReads: number;
	readonly expiresIn: number;
	/** The nonce, or the stream header. */
	readonly nonce: string;
	readonly argon2?: Format1Argon2Vector;
	readonly envelope: string;
}

/** A single-shot format 1 note: the envelope is the ciphertext's additional data. */
export interface Format1PipelineVector {
	readonly description: string;
	readonly keyFragment: string;
	readonly password?: string;
	readonly encryptionKey: string;
	readonly envelope: string;
	readonly payload: PipelineVector["payload"];
	readonly payloadMsgpack: string;
	readonly ciphertext: string;
}

/**
 * A chunked format 1 note, written once: its envelope holds the stream's random
 * header. Every chunk is pushed with the envelope as additional data.
 */
export interface Format1SecretstreamVector {
	readonly description: string;
	readonly keyFragment: string;
	readonly password?: string;
	readonly encryptionKey: string;
	readonly envelope: string;
	readonly chunkSize: number;
	readonly payload: PipelineVector["payload"];
	readonly headerMsgpack: string;
	readonly chunks: ReadonlyArray<string>;
}

export interface EncodingVector {
	readonly description: string;
	readonly raw: string;
	readonly base64url: string;
}

export interface TestVectors {
	readonly version: number;
	readonly generatedWith: string;
	readonly vectors: {
		readonly xchacha20poly1305: ReadonlyArray<XChaCha20Vector>;
		readonly argon2id: ReadonlyArray<Argon2idVector>;
		readonly pipeline: ReadonlyArray<PipelineVector>;
		readonly secretstream: ReadonlyArray<SecretstreamVector>;
		readonly encoding: ReadonlyArray<EncodingVector>;
		readonly format1: {
			readonly keys: ReadonlyArray<Format1KeyVector>;
			readonly envelopes: ReadonlyArray<Format1EnvelopeVector>;
			readonly pipeline: ReadonlyArray<Format1PipelineVector>;
			readonly secretstream: ReadonlyArray<Format1SecretstreamVector>;
		};
	};
}

export const testVectors: TestVectors = vectors as TestVectors;

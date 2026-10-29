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
	readonly fileCount: number;
	readonly maxReads: number;
	readonly expiresIn: number;
	readonly streamHeader: string;
	readonly argon2?: Format1Argon2Vector;
	readonly envelope: string;
}

/** A body's length before padding, and after. */
export interface Format1SizeClassVector {
	readonly length: number;
	readonly sizeClass: number;
}

/** A format 1 payload: format 0's keys, each of them optional. */
export interface Format1PayloadVector {
	readonly text?: string;
	readonly contentMode?: string;
	readonly files?: ReadonlyArray<PipelineFileVector>;
}

/**
 * A format 1 note, written once: its envelope holds the stream's random header.
 * The body is cut every `messageSize` bytes, and every message is pushed with
 * the envelope as additional data.
 */
export interface Format1NoteVector {
	readonly description: string;
	readonly keyFragment: string;
	readonly password?: string;
	readonly encryptionKey: string;
	readonly envelope: string;
	readonly payload: Format1PayloadVector;
	/** The payload without the file bytes, as MessagePack. */
	readonly head: string;
	/** The head's length, the head, the file bytes, then zeros up to the size class. */
	readonly body: string;
	readonly messageSize: number;
	readonly messages: ReadonlyArray<string>;
}

/** What a reader MUST refuse before it reads anything. */
export interface Format1InvalidFragmentVector {
	readonly description: string;
	readonly fragment: string;
}

export interface Format1InvalidEnvelopeVector {
	readonly description: string;
	readonly envelope: string;
}

/**
 * A format 1 note a reader MUST refuse once it has read it, written once: what
 * breaks a rule of the stream or of the body is in its messages, which its key
 * and password open as far as they go.
 */
export interface Format1InvalidNoteVector {
	readonly description: string;
	readonly keyFragment: string;
	readonly password?: string;
	readonly envelope: string;
	readonly messages: ReadonlyArray<string>;
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
			readonly sizeClasses: ReadonlyArray<Format1SizeClassVector>;
			readonly notes: ReadonlyArray<Format1NoteVector>;
			readonly invalid: {
				readonly fragments: ReadonlyArray<Format1InvalidFragmentVector>;
				readonly envelopes: ReadonlyArray<Format1InvalidEnvelopeVector>;
				readonly notes: ReadonlyArray<Format1InvalidNoteVector>;
			};
		};
	};
}

export const testVectors: TestVectors = vectors as TestVectors;

/**
 * The envelope of a format 1 note (PROTOCOL.md): the bytes a writer declares
 * besides its ciphertext, which the ciphertext authenticates as its additional
 * data. The server reads its settings from it and hands it back as it came; a
 * reader opens the note with it.
 *
 * Pure TypeScript, no dependency: the API validates envelopes with it, the SDK
 * writes and reads them.
 */

/** The first byte of an envelope: the note's format. */
export const FORMAT_1 = 1;

const KIND_SINGLE_SHOT = 0;
const KIND_CHUNKED = 1;
const KDF_NONE = 0;
const KDF_ARGON2ID13 = 1;

export const NONCE_LENGTH = 24;
export const SALT_LENGTH = 16;
export const ENVELOPE_LENGTH = 34;
export const ENVELOPE_LENGTH_WITH_PASSWORD = 58;

// The Argon2id parameters a reader agrees to run. A reader runs them before
// anything can tell the envelope was altered, so a server, as much as a
// writer, can make it run the highest: they stay within what a phone's browser
// runs, at most four times the default's cost.
export const ARGON2_MIN_ITERATIONS = 1;
export const ARGON2_MAX_ITERATIONS = 6;
export const ARGON2_MIN_MEMORY_KIB = 65_536;
export const ARGON2_MAX_MEMORY_KIB = 524_288;

/** What a writer derives a password note's key with: libsodium's moderate setting. */
export const ARGON2_DEFAULT_ITERATIONS = 3;
export const ARGON2_DEFAULT_MEMORY_KIB = 262_144;

export interface Argon2Params {
	/** 16 random bytes. */
	readonly salt: Uint8Array;
	readonly iterations: number;
	readonly memoryKiB: number;
}

export interface EnvelopeSettings {
	readonly fileCount: number;
	readonly maxReads: number;
	/** Seconds, from the note's creation. */
	readonly expiresIn: number;
	/** For a password note: how its password was stretched. */
	readonly argon2?: Argon2Params | undefined;
}

export type Envelope = EnvelopeSettings &
	(
		| { readonly kind: "single-shot"; readonly nonce: Uint8Array }
		| { readonly kind: "chunked"; readonly streamHeader: Uint8Array }
	);

export type EnvelopeKind = Envelope["kind"];

function assertRange(name: string, value: number, max: number, min = 0): void {
	if (!Number.isInteger(value) || value < min || value > max) {
		throw new RangeError(`${name} must be an integer from ${String(min)} to ${String(max)}`);
	}
}

function assertLength(name: string, bytes: Uint8Array, length: number): void {
	if (bytes.length !== length) {
		throw new RangeError(`${name} must be ${String(length)} bytes`);
	}
}

/**
 * Throws a RangeError on a setting an envelope cannot hold, and on Argon2id
 * parameters a reader would refuse to run: what a writer checks before it
 * spends anything on a note.
 */
export function assertEnvelopeSettings(settings: EnvelopeSettings): void {
	assertRange("fileCount", settings.fileCount, 0xff);
	assertRange("maxReads", settings.maxReads, 0xffff);
	assertRange("expiresIn", settings.expiresIn, 0xffffffff);
	const { argon2 } = settings;
	if (argon2) {
		assertLength("The salt", argon2.salt, SALT_LENGTH);
		assertRange("iterations", argon2.iterations, ARGON2_MAX_ITERATIONS, ARGON2_MIN_ITERATIONS);
		assertRange("memoryKiB", argon2.memoryKiB, ARGON2_MAX_MEMORY_KIB, ARGON2_MIN_MEMORY_KIB);
	}
}

/** The envelope's bytes. Throws a RangeError as assertEnvelopeSettings does. */
export function encodeEnvelope(envelope: Envelope): Uint8Array {
	assertEnvelopeSettings(envelope);
	const start = envelope.kind === "single-shot" ? envelope.nonce : envelope.streamHeader;
	assertLength("The nonce or stream header", start, NONCE_LENGTH);

	const { argon2 } = envelope;
	const bytes = new Uint8Array(argon2 ? ENVELOPE_LENGTH_WITH_PASSWORD : ENVELOPE_LENGTH);
	const view = new DataView(bytes.buffer);
	bytes[0] = FORMAT_1;
	bytes[1] = envelope.kind === "single-shot" ? KIND_SINGLE_SHOT : KIND_CHUNKED;
	bytes[2] = argon2 ? KDF_ARGON2ID13 : KDF_NONE;
	bytes[3] = envelope.fileCount;
	view.setUint16(4, envelope.maxReads);
	view.setUint32(6, envelope.expiresIn);
	bytes.set(start, 10);

	if (argon2) {
		bytes.set(argon2.salt, ENVELOPE_LENGTH);
		view.setUint32(50, argon2.iterations);
		view.setUint32(54, argon2.memoryKiB);
	}
	return bytes;
}

/**
 * The envelope these bytes hold, or undefined unless they are one exactly:
 * format 1, a known kind and derivation, the length they call for, and Argon2id
 * parameters a reader agrees to run. The settings are not checked against the
 * protocol's limits: that is the server's part, when it accepts a note.
 */
export function parseEnvelope(bytes: Uint8Array): Envelope | undefined {
	if (bytes.length < ENVELOPE_LENGTH || bytes[0] !== FORMAT_1) {
		return undefined;
	}
	const kind = bytes[1];
	const kdf = bytes[2];
	if (kind !== KIND_SINGLE_SHOT && kind !== KIND_CHUNKED) {
		return undefined;
	}
	if (kdf !== KDF_NONE && kdf !== KDF_ARGON2ID13) {
		return undefined;
	}
	const length = kdf === KDF_ARGON2ID13 ? ENVELOPE_LENGTH_WITH_PASSWORD : ENVELOPE_LENGTH;
	if (bytes.length !== length) {
		return undefined;
	}

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const start = bytes.slice(10, ENVELOPE_LENGTH);
	const settings = {
		fileCount: view.getUint8(3),
		maxReads: view.getUint16(4),
		expiresIn: view.getUint32(6),
	};

	let argon2: Argon2Params | undefined;
	if (kdf === KDF_ARGON2ID13) {
		argon2 = {
			salt: bytes.slice(ENVELOPE_LENGTH, ENVELOPE_LENGTH + SALT_LENGTH),
			iterations: view.getUint32(50),
			memoryKiB: view.getUint32(54),
		};
		if (argon2.iterations < ARGON2_MIN_ITERATIONS || argon2.iterations > ARGON2_MAX_ITERATIONS) {
			return undefined;
		}
		if (argon2.memoryKiB < ARGON2_MIN_MEMORY_KIB || argon2.memoryKiB > ARGON2_MAX_MEMORY_KIB) {
			return undefined;
		}
	}

	const withArgon2 = argon2 ? { argon2 } : {};
	return kind === KIND_SINGLE_SHOT
		? { kind: "single-shot", nonce: start, ...settings, ...withArgon2 }
		: { kind: "chunked", streamHeader: start, ...settings, ...withArgon2 };
}

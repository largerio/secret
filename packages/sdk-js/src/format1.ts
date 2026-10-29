import {
	decodeRawBytes,
	decryptRaw,
	deriveFormat1Key,
	encryptPayload,
	generateKey,
	generateNonce,
	generateSalt,
	initStreamEncrypt,
	keyFromBase64Url,
	keyToBase64Url,
	type PasswordInput,
	toBase64,
	zeroMemory,
} from "@largerio/secret-crypto/client";
import {
	ARGON2_DEFAULT_ITERATIONS,
	ARGON2_DEFAULT_MEMORY_KIB,
	type Envelope,
	encodeEnvelope,
	MAX_FILES_PER_NOTE,
	parseEnvelope,
} from "@largerio/secret-shared";
import {
	buildPayload,
	CONTENT_MODES,
	ensureInit,
	openChunkedNote,
	pushChunkedNote,
	type StreamingHeader,
} from "./crypto.js";
import { SecretValidationError } from "./errors.js";
import type { NoteFile, NotePayload } from "./types.js";

/** What a format 1 link's fragment starts with: `1.`, then the key. */
const FRAGMENT_PREFIX = "1.";
const FRAGMENT_RE = /^1\.[A-Za-z0-9_-]{43}$/;

/** The settings a format 1 envelope carries, as the writer chose them. */
export interface Format1Settings {
	readonly fileCount: number;
	readonly maxReads: number;
	readonly expiresIn: number;
}

/** Whether a link's fragment names format 1, well formed or not. */
export function isFormat1Fragment(keyFragment: string): boolean {
	return keyFragment.startsWith(FRAGMENT_PREFIX);
}

/**
 * The key of a format 1 fragment. A malformed one is refused before anything
 * is read: it could only spend a read for nothing.
 */
function linkKeyOf(keyFragment: string): Uint8Array {
	if (!FRAGMENT_RE.test(keyFragment)) {
		throw new SecretValidationError("Invalid key fragment");
	}
	try {
		// libsodium refuses a key whose last character carries stray bits.
		return keyFromBase64Url(keyFragment.slice(FRAGMENT_PREFIX.length));
	} catch {
		throw new SecretValidationError("Invalid key fragment");
	}
}

/** Checks a format 1 fragment before a read, so a malformed link spends none. */
export function assertFormat1Fragment(keyFragment: string): void {
	zeroMemory(linkKeyOf(keyFragment));
}

/** Throws a SecretValidationError for settings an envelope cannot carry. */
function encodeWriterEnvelope(envelope: Envelope): Uint8Array {
	try {
		return encodeEnvelope(envelope);
	} catch (err) {
		// encodeEnvelope throws a RangeError naming the field.
		throw new SecretValidationError((err as RangeError).message);
	}
}

/** A new note's link key, its password's derivation, and the key both give. */
function newKeys(password: string | undefined): {
	readonly linkKey: Uint8Array;
	readonly passwordInput: PasswordInput | undefined;
	readonly encryptionKey: Uint8Array;
} {
	const linkKey = generateKey();
	const passwordInput = password
		? {
				password,
				argon2: {
					salt: generateSalt(),
					iterations: ARGON2_DEFAULT_ITERATIONS,
					memoryKiB: ARGON2_DEFAULT_MEMORY_KIB,
				},
			}
		: undefined;
	return { linkKey, passwordInput, encryptionKey: deriveFormat1Key(linkKey, passwordInput) };
}

export interface Format1EncryptResult {
	readonly encryptedBytes: Uint8Array;
	readonly encryptedData: string;
	/** In base64. */
	readonly envelope: string;
	readonly keyFragment: string;
}

/** Encrypts a single-shot note in format 1. */
export async function encryptNoteFormat1(
	payload: NotePayload,
	settings: Format1Settings,
	password?: string,
): Promise<Format1EncryptResult> {
	await ensureInit();
	const { linkKey, passwordInput, encryptionKey } = newKeys(password);
	try {
		const nonce = generateNonce();
		const envelope = encodeWriterEnvelope({
			kind: "single-shot",
			nonce,
			...settings,
			argon2: passwordInput?.argon2,
		});
		const { ciphertext } = encryptPayload(payload, encryptionKey, nonce, envelope);
		return {
			encryptedBytes: ciphertext,
			encryptedData: toBase64(ciphertext),
			envelope: toBase64(envelope),
			keyFragment: `${FRAGMENT_PREFIX}${keyToBase64Url(linkKey)}`,
		};
	} finally {
		zeroMemory(encryptionKey);
		zeroMemory(linkKey);
	}
}

export interface Format1ChunkedEncryptResult {
	readonly chunks: Uint8Array[];
	/** In base64. */
	readonly envelope: string;
	readonly keyFragment: string;
}

/** Encrypts a chunked note in format 1. */
export async function encryptNoteChunkedFormat1(
	payload: NotePayload,
	chunkSize: number,
	settings: Format1Settings,
	password?: string,
): Promise<Format1ChunkedEncryptResult> {
	await ensureInit();
	const { linkKey, passwordInput, encryptionKey } = newKeys(password);
	try {
		const { state, header } = initStreamEncrypt(encryptionKey);
		const envelope = encodeWriterEnvelope({
			kind: "chunked",
			streamHeader: header,
			...settings,
			argon2: passwordInput?.argon2,
		});
		return {
			chunks: pushChunkedNote(state, payload, chunkSize, envelope),
			envelope: toBase64(envelope),
			keyFragment: `${FRAGMENT_PREFIX}${keyToBase64Url(linkKey)}`,
		};
	} finally {
		zeroMemory(encryptionKey);
		zeroMemory(linkKey);
	}
}

/**
 * The key a format 1 note opens with, from its link and its envelope. A note
 * whose envelope calls for a password is not opened without one; a password
 * given for a note without one is ignored, as the authenticated envelope says.
 */
function openingKey(keyFragment: string, envelope: Envelope, password: string | undefined) {
	if (envelope.argon2 && !password) {
		throw new Error("The note requires a password");
	}
	const linkKey = linkKeyOf(keyFragment);
	try {
		return deriveFormat1Key(
			linkKey,
			envelope.argon2 && password ? { password, argon2: envelope.argon2 } : undefined,
		);
	} finally {
		zeroMemory(linkKey);
	}
}

/**
 * The envelope the server handed back, of the kind its endpoint serves. None
 * means a format 0 note behind a format 1 link: it cannot open either.
 */
function envelopeOf<K extends Envelope["kind"]>(
	bytes: Uint8Array | undefined,
	kind: K,
): { readonly envelope: Extract<Envelope, { kind: K }>; readonly bytes: Uint8Array } {
	const envelope = bytes === undefined ? undefined : parseEnvelope(bytes);
	if (bytes === undefined || envelope?.kind !== kind) {
		throw new Error("Not a format 1 note of this kind");
	}
	return { envelope: envelope as Extract<Envelope, { kind: K }>, bytes };
}

/** Decrypts a single-shot format 1 note. Throws on anything but a well-formed payload. */
export async function decryptNoteFormat1(
	encryptedBytes: Uint8Array,
	envelopeBytes: Uint8Array | undefined,
	keyFragment: string,
	password?: string,
): Promise<NotePayload> {
	await ensureInit();
	const { envelope, bytes } = envelopeOf(envelopeBytes, "single-shot");
	const key = openingKey(keyFragment, envelope, password);
	try {
		const plaintext = decryptRaw(encryptedBytes, envelope.nonce, key, bytes);
		const payload = strictPayload(decodeRawBytes(plaintext));
		assertFileCount(payload, envelope);
		return payload;
	} finally {
		zeroMemory(key);
	}
}

/** Decrypts a chunked format 1 note. Throws on anything but a well-formed stream. */
export async function decryptNoteChunkedFormat1(
	encryptedChunks: Uint8Array[],
	envelopeBytes: Uint8Array | undefined,
	keyFragment: string,
	password?: string,
): Promise<NotePayload> {
	await ensureInit();
	const { envelope, bytes } = envelopeOf(envelopeBytes, "chunked");
	const key = openingKey(keyFragment, envelope, password);
	try {
		const payload = openChunkedNote(encryptedChunks, envelope.streamHeader, key, {
			additionalData: bytes,
			isHead: isStrictHead,
			exact: true,
		});
		assertFileCount(payload, envelope);
		return payload;
	} finally {
		zeroMemory(key);
	}
}

function assertFileCount(payload: NotePayload, envelope: Envelope): void {
	if ((payload.files?.length ?? 0) !== envelope.fileCount) {
		throw new Error("The payload does not hold the files its envelope declares");
	}
}

// --- The payload, read strictly ---

function isMap(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		!(value instanceof Uint8Array)
	);
}

/** `text` and `contentMode`, each absent or of its type; unknown keys are ignored. */
function hasValidText(value: Record<string, unknown>): boolean {
	const { text, contentMode } = value;
	if (text !== undefined && typeof text !== "string") return false;
	return contentMode === undefined || CONTENT_MODES.has(contentMode as string);
}

/** A file's name, type and size: what the head of a chunked note lists. */
function isFileHead(value: unknown): value is { name: string; type: string; size: number } {
	return (
		isMap(value) &&
		typeof value["name"] === "string" &&
		typeof value["type"] === "string" &&
		Number.isSafeInteger(value["size"]) &&
		(value["size"] as number) >= 0
	);
}

function hasValidFiles(value: Record<string, unknown>, isFile: (file: unknown) => boolean) {
	const { files } = value;
	if (files === undefined) return true;
	return Array.isArray(files) && files.length <= MAX_FILES_PER_NOTE && files.every(isFile);
}

function isStrictHead(value: unknown): value is StreamingHeader {
	return isMap(value) && hasValidText(value) && hasValidFiles(value, isFileHead);
}

function isStrictFile(value: unknown): value is NoteFile {
	if (!isFileHead(value)) return false;
	const { data } = value as { readonly data?: unknown };
	return data instanceof Uint8Array && data.length === value.size;
}

/** A single-shot payload, rebuilt from its known keys once every one checks out. */
function strictPayload(value: unknown): NotePayload {
	if (!isMap(value) || !hasValidText(value) || !hasValidFiles(value, isStrictFile)) {
		throw new Error("Malformed payload");
	}
	const files = (value["files"] as NoteFile[] | undefined) ?? [];
	return buildPayload(
		value as StreamingHeader,
		files.map(({ name, type, size, data }) => ({ name, type, size, data })),
	);
}

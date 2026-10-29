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
	assertEnvelopeSettings,
	type Envelope,
	type EnvelopeSettings,
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
/** A fragment that names its format: a number and a dot, which a format 0 key never holds. */
const NUMBERED_FRAGMENT_RE = /^(\d+)\./;

/** The formats a note can be in, as its link names them. */
export type NoteFormat = 0 | 1;

/** The settings a format 1 envelope carries, as the writer chose them. */
export interface Format1Settings {
	readonly fileCount: number;
	readonly maxReads: number;
	readonly expiresIn: number;
}

/**
 * The format a link's fragment names: 1 after `1.`, 0 for a bare key. Another
 * number names a format this SDK cannot read, refused before anything is read.
 */
export function formatOfFragment(keyFragment: string): NoteFormat {
	const numbered = NUMBERED_FRAGMENT_RE.exec(keyFragment);
	if (numbered === null) {
		return 0;
	}
	if (numbered[1] !== "1") {
		throw new SecretValidationError("Unsupported note format");
	}
	return 1;
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

/** Refuses, before any work, settings an envelope cannot hold. */
function assertWriterSettings(settings: EnvelopeSettings): void {
	try {
		assertEnvelopeSettings(settings);
	} catch (err) {
		// assertEnvelopeSettings throws a RangeError naming the setting.
		throw new SecretValidationError((err as RangeError).message);
	}
}

// A lone surrogate is not text: MessagePack would write it as bytes no UTF-8
// decoder accepts, or as U+FFFD, depending on the string's length.
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** The string as WHATWG UTF-8 encodes it: each lone surrogate becomes U+FFFD. */
function wellFormed(value: string): string {
	return value.replace(LONE_SURROGATE_RE, "�");
}

/** The payload with every string well formed, so that it encodes to valid UTF-8. */
function wellFormedPayload(payload: NotePayload): NotePayload {
	return {
		...payload,
		...(payload.text !== undefined ? { text: wellFormed(payload.text) } : {}),
		...(payload.files
			? {
					files: payload.files.map((file) => ({
						...file,
						name: wellFormed(file.name),
						type: wellFormed(file.type),
					})),
				}
			: {}),
	};
}

/** A new note's link key and, for a password note, how its password is stretched. */
function newNoteSecrets(password: string | undefined): {
	readonly linkKey: Uint8Array;
	readonly passwordInput: PasswordInput | undefined;
} {
	return {
		linkKey: generateKey(),
		passwordInput: password
			? {
					password,
					argon2: {
						salt: generateSalt(),
						iterations: ARGON2_DEFAULT_ITERATIONS,
						memoryKiB: ARGON2_DEFAULT_MEMORY_KIB,
					},
				}
			: undefined,
	};
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
	const { linkKey, passwordInput } = newNoteSecrets(password);
	let encryptionKey: Uint8Array | undefined;
	try {
		const nonce = generateNonce();
		const envelope = encodeEnvelopeOrRefuse({
			kind: "single-shot",
			nonce,
			...settings,
			argon2: passwordInput?.argon2,
		});
		encryptionKey = deriveFormat1Key(linkKey, passwordInput);
		const { ciphertext } = encryptPayload(
			wellFormedPayload(payload),
			encryptionKey,
			nonce,
			envelope,
		);
		return {
			encryptedBytes: ciphertext,
			encryptedData: toBase64(ciphertext),
			envelope: toBase64(envelope),
			keyFragment: `${FRAGMENT_PREFIX}${keyToBase64Url(linkKey)}`,
		};
	} finally {
		if (encryptionKey) {
			zeroMemory(encryptionKey);
		}
		zeroMemory(linkKey);
	}
}

/** The envelope's bytes, or a SecretValidationError for settings it cannot hold. */
function encodeEnvelopeOrRefuse(envelope: Envelope): Uint8Array {
	assertWriterSettings(envelope);
	return encodeEnvelope(envelope);
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
	const { linkKey, passwordInput } = newNoteSecrets(password);
	let encryptionKey: Uint8Array | undefined;
	try {
		// The stream header comes from the key: the settings are checked first,
		// so that a refusal costs no Argon2id.
		const argon2 = passwordInput?.argon2;
		assertWriterSettings({ ...settings, argon2 });
		encryptionKey = deriveFormat1Key(linkKey, passwordInput);
		const { state, header } = initStreamEncrypt(encryptionKey);
		const envelope = encodeEnvelope({ kind: "chunked", streamHeader: header, ...settings, argon2 });
		return {
			chunks: pushChunkedNote(state, wellFormedPayload(payload), chunkSize, envelope),
			envelope: toBase64(envelope),
			keyFragment: `${FRAGMENT_PREFIX}${keyToBase64Url(linkKey)}`,
		};
	} finally {
		if (encryptionKey) {
			zeroMemory(encryptionKey);
		}
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

/** The envelope the server handed back, of the kind its endpoint serves. */
function envelopeOf<K extends Envelope["kind"]>(
	bytes: Uint8Array,
	kind: K,
): Extract<Envelope, { kind: K }> {
	const envelope = parseEnvelope(bytes);
	if (envelope?.kind !== kind) {
		throw new Error("Not a format 1 note of this kind");
	}
	return envelope as Extract<Envelope, { kind: K }>;
}

/** Decrypts a single-shot format 1 note. Throws on anything but a well-formed payload. */
export async function decryptNoteFormat1(
	encryptedBytes: Uint8Array,
	envelopeBytes: Uint8Array,
	keyFragment: string,
	password?: string,
): Promise<NotePayload> {
	await ensureInit();
	const envelope = envelopeOf(envelopeBytes, "single-shot");
	const key = openingKey(keyFragment, envelope, password);
	try {
		const plaintext = decryptRaw(encryptedBytes, envelope.nonce, key, envelopeBytes);
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
	envelopeBytes: Uint8Array,
	keyFragment: string,
	password?: string,
): Promise<NotePayload> {
	await ensureInit();
	const envelope = envelopeOf(envelopeBytes, "chunked");
	const key = openingKey(keyFragment, envelope, password);
	try {
		const payload = openChunkedNote(encryptedChunks, envelope.streamHeader, key, {
			additionalData: envelopeBytes,
			isHead: isStrictHead,
			strict: true,
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

/**
 * Whether a decoded value is a MessagePack map. The decoder makes plain
 * objects of maps only: an extension decodes to a Date or an ExtData.
 */
function isMap(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype
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

import {
	decodeRawBytes,
	decryptChunk,
	deriveFormat1Keys,
	encodeRaw,
	encryptChunk,
	type Format1Keys,
	fromBase64,
	generateKey,
	generateSalt,
	initStreamDecrypt,
	initStreamEncrypt,
	keyFromBase64Url,
	keyToBase64Url,
	type PasswordInput,
	SECRETSTREAM_ABYTES,
	toBase64,
	verifierOf,
	zeroFormat1Keys,
	zeroMemory,
} from "@largerio/secret-crypto/client";
import {
	ARGON2_DEFAULT_ITERATIONS,
	ARGON2_DEFAULT_MEMORY_KIB,
	assertEnvelopeSettings,
	type Envelope,
	type EnvelopeSettings,
	encodeEnvelope,
	HEAD_LENGTH_BYTES,
	MAX_FILES_PER_NOTE,
	parseEnvelope,
	sizeClass,
} from "@largerio/secret-shared";
import { buildPayload, CONTENT_MODES, ensureInit, headOf, type StreamingHeader } from "./crypto.js";
import { SecretValidationError } from "./errors.js";
import type { NotePayload } from "./types.js";

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

/**
 * What a format 1 writer sends beside the envelope, never inside it: SHA-256
 * of each proof its readers will send, in base64.
 */
export interface Format1Verifiers {
	readonly linkVerifier: string;
	readonly passwordVerifier?: string;
}

/** The verifiers of a new note's proofs. */
function verifiersOf(keys: Format1Keys): Format1Verifiers {
	return {
		linkVerifier: toBase64(verifierOf(keys.linkProof)),
		...(keys.passwordProof ? { passwordVerifier: toBase64(verifierOf(keys.passwordProof)) } : {}),
	};
}

/** A note's body, before it is encrypted: its parts, and the length padding takes it to. */
export interface Format1Body {
	/** The head's length, 4 bytes big-endian, then the head: wiped once encrypted. */
	readonly head: Uint8Array;
	/** Each file's bytes, the caller's own: read, never written. */
	readonly files: ReadonlyArray<Uint8Array>;
	/** The size class of the head and files' length: the rest of the body is zeros. */
	readonly length: number;
}

/**
 * A note's body (PROTOCOL.md): the head's length, 4 bytes big-endian, the
 * head, the file bytes, then zeros up to the size class. Laid out, not copied:
 * the file bytes are only read as the messages are cut.
 */
export function format1BodyOf(payload: NotePayload): Format1Body {
	const encoded = encodeRaw(headOf(wellFormedPayload(payload)));
	const head = new Uint8Array(HEAD_LENGTH_BYTES + encoded.length);
	new DataView(head.buffer).setUint32(0, encoded.length);
	head.set(encoded, HEAD_LENGTH_BYTES);
	zeroMemory(encoded);
	const files = (payload.files ?? []).map((file) => file.data);
	const content = files.reduce((sum, data) => sum + data.length, head.length);
	return { head, files, length: sizeClass(content) };
}

/**
 * The body, `messageSize` bytes at a time: every message but the last holds
 * that many, the last the rest. Each is a fresh copy, so that it can be wiped
 * once encrypted, and only one is held at a time.
 */
function* bodyMessages(body: Format1Body, messageSize: number): Generator<Uint8Array> {
	const parts = [body.head, ...body.files];
	let part = 0;
	let offset = 0;
	for (let start = 0; start < body.length; start += messageSize) {
		const message = new Uint8Array(Math.min(messageSize, body.length - start));
		let filled = 0;
		// Past the last part, the message keeps the zeros it was made with.
		while (filled < message.length && part < parts.length) {
			const source = parts[part] as Uint8Array;
			const taken = Math.min(source.length - offset, message.length - filled);
			message.set(source.subarray(offset, offset + taken), filled);
			filled += taken;
			offset += taken;
			if (offset === source.length) {
				part++;
				offset = 0;
			}
		}
		yield message;
	}
}

export interface Format1EncryptResult {
	readonly messages: Uint8Array[];
	/** In base64. */
	readonly envelope: string;
	readonly verifiers: Format1Verifiers;
	readonly keyFragment: string;
}

/**
 * Encrypts a note in format 1: one secretstream, the body cut into messages of
 * `messageSize` bytes, each authenticating the envelope. A note sent in one
 * request is one message: `messageSize` is then the body's length. A body is
 * encrypted once: its head is wiped on the way out, whatever happens.
 */
export async function encryptNoteFormat1(
	body: Format1Body,
	messageSize: number,
	settings: Format1Settings,
	password?: string,
): Promise<Format1EncryptResult> {
	await ensureInit();
	if (!Number.isSafeInteger(messageSize) || messageSize < 1) {
		throw new SecretValidationError("The message size must be a positive integer");
	}
	const { linkKey, passwordInput } = newNoteSecrets(password);
	let keys: Format1Keys | undefined;
	try {
		// The stream header comes from the key: the settings are checked first,
		// so that a refusal costs no Argon2id.
		const argon2 = passwordInput?.argon2;
		assertWriterSettings({ ...settings, argon2 });
		keys = deriveFormat1Keys(linkKey, passwordInput);
		const { state, header } = initStreamEncrypt(keys.encryptionKey);
		const envelope = encodeEnvelope({ streamHeader: header, ...settings, argon2 });
		const count = Math.ceil(body.length / messageSize);
		const messages: Uint8Array[] = [];
		for (const plaintext of bodyMessages(body, messageSize)) {
			try {
				messages.push(encryptChunk(state, plaintext, messages.length === count - 1, envelope));
			} finally {
				zeroMemory(plaintext);
			}
		}
		return {
			messages,
			envelope: toBase64(envelope),
			verifiers: verifiersOf(keys),
			keyFragment: `${FRAGMENT_PREFIX}${keyToBase64Url(linkKey)}`,
		};
	} finally {
		if (keys) {
			zeroFormat1Keys(keys);
		}
		zeroMemory(linkKey);
		zeroMemory(body.head);
	}
}

/** The body of `POST /notes/{id}/reads`: the proofs, in base64. */
export interface ReadProofs {
	readonly linkProof: string;
	readonly passwordProof?: string;
}

/**
 * A format 1 note about to be read: its envelope, as `/exists` served it, and
 * what the link and the password derive from it. The proofs make the server
 * serve the note; the key opens what it serves. Close it once read.
 */
export interface Format1Read {
	readonly envelope: Envelope;
	readonly envelopeBytes: Uint8Array;
	readonly proofs: ReadProofs;
	readonly encryptionKey: Uint8Array;
}

/**
 * Derives what reading a format 1 note takes, before anything is read. An
 * envelope a reader refuses is refused here, and so is a password note without
 * a password: either would spend a request for nothing. A password given for a
 * note without one is ignored, as the envelope says.
 */
export async function prepareFormat1Read(
	envelopeBase64: string | undefined,
	keyFragment: string,
	password: string | undefined,
): Promise<Format1Read> {
	await ensureInit();
	if (envelopeBase64 === undefined) {
		throw new Error("Not a format 1 note");
	}
	const envelopeBytes = fromBase64(envelopeBase64);
	const envelope = parseEnvelope(envelopeBytes);
	if (envelope === undefined) {
		throw new Error("Not a format 1 envelope");
	}
	if (envelope.argon2 && !password) {
		throw new Error("The note requires a password");
	}

	const linkKey = linkKeyOf(keyFragment);
	let keys: Format1Keys;
	try {
		keys = deriveFormat1Keys(
			linkKey,
			envelope.argon2 && password ? { password, argon2: envelope.argon2 } : undefined,
		);
	} finally {
		zeroMemory(linkKey);
	}
	// The proofs are only needed as the request's body: their bytes go now,
	// the key stays until the note is opened.
	const proofs = {
		linkProof: toBase64(keys.linkProof),
		...(keys.passwordProof ? { passwordProof: toBase64(keys.passwordProof) } : {}),
	};
	zeroMemory(keys.linkProof);
	if (keys.passwordProof) {
		zeroMemory(keys.passwordProof);
	}
	return { envelope, envelopeBytes, proofs, encryptionKey: keys.encryptionKey };
}

/** Wipes the key of a note once it is read, or could not be. */
export function closeFormat1Read(read: Format1Read): void {
	zeroMemory(read.encryptionKey);
}

/**
 * Opens a format 1 note from its messages: the stream checked tag by tag, then
 * its body, strictly. Throws on anything else.
 */
export function openNoteFormat1(
	read: Format1Read,
	messages: ReadonlyArray<Uint8Array>,
): NotePayload {
	const { envelope, envelopeBytes, encryptionKey } = read;
	if (messages.length === 0) {
		throw new Error("No message to open");
	}
	// Each message opens straight into the body, its own plaintext wiped: one
	// copy of the note, which a refused note does not keep either.
	const length = messages.reduce(
		(sum, message) => sum + Math.max(0, message.length - SECRETSTREAM_ABYTES),
		0,
	);
	const body = new Uint8Array(length);
	try {
		const state = initStreamDecrypt(envelope.streamHeader, encryptionKey);
		let offset = 0;
		for (const [index, message] of messages.entries()) {
			const { decrypted, isFinal, isMessage } = decryptChunk(state, message, envelopeBytes);
			body.set(decrypted, offset);
			offset += decrypted.length;
			zeroMemory(decrypted);
			// The last message, and only it, is FINAL: secretstream authenticates
			// each message and their order, but only the tags prove none were
			// dropped from the end.
			const isLast = index === messages.length - 1;
			if (isLast ? !isFinal : !isMessage) {
				throw new Error("Encrypted stream is truncated or extended");
			}
		}
		return openBody(body, envelope);
	} catch (err) {
		zeroMemory(body);
		throw err;
	}
}

/** A note's payload, from its body: read as PROTOCOL.md lays it out, and refused otherwise. */
function openBody(body: Uint8Array, envelope: Envelope): NotePayload {
	if (body.length < HEAD_LENGTH_BYTES) {
		throw new Error("Malformed body");
	}
	const headEnd =
		HEAD_LENGTH_BYTES + new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(0);
	if (headEnd > body.length) {
		throw new Error("Malformed body");
	}
	// One MessagePack value that fills the head: the decoder refuses a value cut
	// short, and bytes left after it.
	const head = decodeRawBytes(body.subarray(HEAD_LENGTH_BYTES, headEnd));
	if (!isStrictHead(head)) {
		throw new Error("Malformed payload");
	}
	const declared = head.files ?? [];
	if (declared.length !== envelope.fileCount) {
		throw new Error("The payload does not hold the files its envelope declares");
	}

	let offset = headEnd;
	const files = declared.map(({ name, type, size }) => {
		if (size > body.length - offset) {
			throw new Error("Decrypted file data does not match the declared size");
		}
		const data = body.subarray(offset, offset + size);
		offset += size;
		return { name, type, size, data };
	});
	if (body.length !== sizeClass(offset) || body.subarray(offset).some((byte) => byte !== 0)) {
		throw new Error("Malformed padding");
	}
	return buildPayload(head, files);
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

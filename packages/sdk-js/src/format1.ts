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
	type StreamEncryptState,
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
import { buildPayload, CONTENT_MODES, ensureInit, type StreamingHeader } from "./crypto.js";
import { SecretValidationError } from "./errors.js";
import type {
	ContentMode,
	FileBytes,
	NoteFileInfo,
	NotePayload,
	ReadNoteIntoOptions,
} from "./types.js";

type StreamState = StreamEncryptState["state"];

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

/** A note as its writer gives it, each file's bytes in memory or in a Blob. */
export interface NoteSource {
	readonly text?: string;
	readonly contentMode?: ContentMode;
	readonly files?: ReadonlyArray<{
		readonly name: string;
		readonly type: string;
		readonly data: FileBytes;
	}>;
}

/** The length of a file's bytes, in memory or in a Blob. */
export function sizeOf(data: FileBytes): number {
	return data instanceof Uint8Array ? data.length : data.size;
}

/** The head of a note, every string well formed, so that it encodes to valid UTF-8. */
function headOfSource(source: NoteSource): StreamingHeader {
	const files = source.files ?? [];
	return {
		...(source.text !== undefined ? { text: wellFormed(source.text) } : {}),
		...(source.contentMode ? { contentMode: source.contentMode } : {}),
		...(files.length > 0
			? {
					files: files.map((file) => ({
						name: wellFormed(file.name),
						type: wellFormed(file.type),
						size: sizeOf(file.data),
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
	readonly files: ReadonlyArray<FileBytes>;
	/** The size class of the head and files' length: the rest of the body is zeros. */
	readonly length: number;
}

/**
 * A note's body (PROTOCOL.md): the head's length, 4 bytes big-endian, the
 * head, the file bytes, then zeros up to the size class. Laid out, not copied:
 * the file bytes are only read as the messages are cut, a Blob a slice at a
 * time.
 */
export function format1BodyOf(source: NoteSource): Format1Body {
	const encoded = encodeRaw(headOfSource(source));
	const head = new Uint8Array(HEAD_LENGTH_BYTES + encoded.length);
	new DataView(head.buffer).setUint32(0, encoded.length);
	head.set(encoded, HEAD_LENGTH_BYTES);
	zeroMemory(encoded);
	const files = (source.files ?? []).map((file) => file.data);
	const content = files.reduce((sum, data) => sum + sizeOf(data), head.length);
	return { head, files, length: sizeClass(content) };
}

/**
 * Copies `length` bytes of `source` from `start` into `target` at `at`. A
 * Blob's slice is read, then wiped: a file changed on disk since its size was
 * taken is refused rather than sealed short.
 */
async function copyPart(
	source: FileBytes,
	start: number,
	length: number,
	target: Uint8Array,
	at: number,
): Promise<void> {
	if (source instanceof Uint8Array) {
		target.set(source.subarray(start, start + length), at);
		return;
	}
	const bytes = new Uint8Array(await source.slice(start, start + length).arrayBuffer());
	try {
		if (bytes.length !== length) {
			throw new SecretValidationError("A file changed while it was read");
		}
		target.set(bytes, at);
	} finally {
		zeroMemory(bytes);
	}
}

/**
 * The body, `messageSize` bytes at a time: every message but the last holds
 * that many, the last the rest. Each is a fresh copy, so that it can be wiped
 * once encrypted, and only one is held at a time.
 */
async function* bodyMessages(body: Format1Body, messageSize: number): AsyncGenerator<Uint8Array> {
	const parts = [body.head, ...body.files];
	let part = 0;
	let offset = 0;
	for (let start = 0; start < body.length; start += messageSize) {
		const message = new Uint8Array(Math.min(messageSize, body.length - start));
		let filled = 0;
		// Past the last part, the message keeps the zeros it was made with.
		while (filled < message.length && part < parts.length) {
			const source = parts[part] as FileBytes;
			const taken = Math.min(sizeOf(source) - offset, message.length - filled);
			if (taken > 0) {
				await copyPart(source, offset, taken, message, filled);
			}
			filled += taken;
			offset += taken;
			if (offset === sizeOf(source)) {
				part++;
				offset = 0;
			}
		}
		yield message;
	}
}

/**
 * A format 1 note being sealed: what its writer sends before the messages,
 * then the messages, each encrypted as it is pulled. Close it once they are
 * sent, or given up: its head is wiped then, if pulling them did not.
 */
export interface Format1Sealing {
	/** In base64. */
	readonly envelope: string;
	readonly verifiers: Format1Verifiers;
	readonly keyFragment: string;
	/** How many messages the body is cut into. */
	readonly messageCount: number;
	/** Pulled once: each message's plaintext is wiped once encrypted. */
	readonly messages: AsyncGenerator<Uint8Array>;
	close(): void;
}

/**
 * Seals a note in format 1: one secretstream, the body cut into messages of
 * `messageSize` bytes, each authenticating the envelope. The keys are derived
 * and the envelope built at once, before any message is encrypted, so that an
 * upload session can be opened first; the messages are encrypted as they are
 * pulled. A body is encrypted once: its head is wiped on the way out,
 * whatever happens.
 */
export async function sealNoteFormat1(
	body: Format1Body,
	messageSize: number,
	settings: Format1Settings,
	password?: string,
): Promise<Format1Sealing> {
	await ensureInit();
	if (!Number.isSafeInteger(messageSize) || messageSize < 1) {
		throw new SecretValidationError("The message size must be a positive integer");
	}
	const { linkKey, passwordInput } = newNoteSecrets(password);
	const close = () => zeroMemory(body.head);
	let keys: Format1Keys | undefined;
	try {
		// The stream header comes from the key: the settings are checked first,
		// so that a refusal costs no Argon2id.
		const argon2 = passwordInput?.argon2;
		assertWriterSettings({ ...settings, argon2 });
		keys = deriveFormat1Keys(linkKey, passwordInput);
		const { state, header } = initStreamEncrypt(keys.encryptionKey);
		const envelope = encodeEnvelope({ streamHeader: header, ...settings, argon2 });
		const messageCount = Math.ceil(body.length / messageSize);
		return {
			envelope: toBase64(envelope),
			verifiers: verifiersOf(keys),
			keyFragment: `${FRAGMENT_PREFIX}${keyToBase64Url(linkKey)}`,
			messageCount,
			messages: sealedMessages(body, messageSize, messageCount, state, envelope, close),
			close,
		};
	} catch (err) {
		close();
		throw err;
	} finally {
		// The stream's state holds what encrypting takes from here.
		if (keys) {
			zeroFormat1Keys(keys);
		}
		zeroMemory(linkKey);
	}
}

/** A sealing's messages: the last one FINAL, the head wiped once they are all pulled. */
async function* sealedMessages(
	body: Format1Body,
	messageSize: number,
	messageCount: number,
	state: StreamState,
	envelope: Uint8Array,
	close: () => void,
): AsyncGenerator<Uint8Array> {
	try {
		let index = 0;
		for await (const plaintext of bodyMessages(body, messageSize)) {
			let message: Uint8Array;
			try {
				message = encryptChunk(state, plaintext, index === messageCount - 1, envelope);
			} finally {
				zeroMemory(plaintext);
			}
			index++;
			yield message;
		}
	} finally {
		close();
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
 * Encrypts a note in format 1, every message at once: a note sent in one
 * request is one message, `messageSize` then being the body's length.
 */
export async function encryptNoteFormat1(
	body: Format1Body,
	messageSize: number,
	settings: Format1Settings,
	password?: string,
): Promise<Format1EncryptResult> {
	const sealing = await sealNoteFormat1(body, messageSize, settings, password);
	try {
		const messages: Uint8Array[] = [];
		for await (const message of sealing.messages) {
			messages.push(message);
		}
		const { envelope, verifiers, keyFragment } = sealing;
		return { messages, envelope, verifiers, keyFragment };
	} finally {
		sealing.close();
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
	const head = readHead(body.subarray(HEAD_LENGTH_BYTES, headEnd), envelope);
	const declared = head.files ?? [];

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

/**
 * A note's head, from its bytes: one MessagePack value that fills them, read
 * strictly, holding as many files as the envelope declares.
 */
function readHead(bytes: Uint8Array, envelope: Envelope): StreamingHeader {
	// The decoder refuses a value cut short, and bytes left after it.
	const head = decodeRawBytes(bytes);
	if (!isStrictHead(head)) {
		throw new Error("Malformed payload");
	}
	if ((head.files ?? []).length !== envelope.fileCount) {
		throw new Error("The payload does not hold the files its envelope declares");
	}
	return head;
}

// --- A note read as a stream ---

/** Opens the stream a streamed read writes a file's bytes to. */
type OpenFile = ReadNoteIntoOptions["openFile"];

/** What a streamed read tells of a note besides its files' bytes. */
export interface Format1Head {
	readonly text?: string;
	readonly contentMode?: ContentMode;
	readonly files: ReadonlyArray<NoteFileInfo>;
}

/**
 * A failure that is not the note's: its download's, or one of the caller's
 * streams'. The client throws its cause as it is, where a failure of the
 * note's own becomes the uniform decryption error.
 */
export class OutsideFailure {
	constructor(readonly cause: unknown) {}
}

/** Runs an operation of the caller's streams, whose failure is not the note's. */
async function outside<T>(operation: () => Promise<T> | T): Promise<T> {
	try {
		return await operation();
	} catch (err) {
		throw new OutsideFailure(err);
	}
}

/** A download's messages, whose failure is not the note's. */
async function* downloaded(messages: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
	try {
		yield* messages;
	} catch (err) {
		throw new OutsideFailure(err);
	}
}

/** One array of `pieces`, which are wiped. */
function joined(pieces: ReadonlyArray<Uint8Array>, length: number): Uint8Array {
	const whole = new Uint8Array(length);
	let offset = 0;
	for (const piece of pieces) {
		whole.set(piece, offset);
		offset += piece.length;
		zeroMemory(piece);
	}
	return whole;
}

/**
 * A format 1 body read as its messages open, as `openBody` reads it whole: the
 * head gathered until whole, then read strictly; each file's bytes written to
 * the stream opened for it once the body reaches it; the padding checked.
 * `finish` checks the body once its last message is open, before any stream
 * is closed.
 */
class BodyReader {
	/** The body's length so far. */
	private length = 0;
	/** The length field, then the head, gathered in copies until whole. */
	private gathered: Uint8Array[] = [];
	private gatheredLength = 0;
	private headEnd: number | undefined;
	private head: StreamingHeader | undefined;
	private files: ReadonlyArray<NoteFileInfo> = [];
	/** The head's length and the files'. */
	private content = 0;
	/** The file the body has reached, and how much of it is written. */
	private file = 0;
	private written = 0;
	private paddingIsZeros = true;
	private readonly writers: WritableStreamDefaultWriter<Uint8Array>[] = [];

	constructor(
		private readonly envelope: Envelope,
		private readonly openFile: OpenFile,
	) {}

	/** Reads the body's next bytes, which the caller wipes once this resolves. */
	async push(bytes: Uint8Array): Promise<void> {
		this.length += bytes.length;
		let rest = this.gatherHead(bytes);
		if (this.head === undefined) {
			return;
		}
		await this.reach();
		while (rest.length > 0 && this.file < this.files.length) {
			const file = this.files[this.file] as NoteFileInfo;
			const writer = this.writers[this.file] as WritableStreamDefaultWriter<Uint8Array>;
			const taken = Math.min(rest.length, file.size - this.written);
			// A copy, the stream's own: the bytes read are wiped.
			const chunk = rest.slice(0, taken);
			await outside(() => writer.write(chunk));
			this.written += taken;
			rest = rest.subarray(taken);
			await this.reach();
		}
		if (rest.some((byte) => byte !== 0)) {
			this.paddingIsZeros = false;
		}
	}

	/** Gathers the length field and the head, reading the head once whole: returns what follows. */
	private gatherHead(bytes: Uint8Array): Uint8Array {
		let rest = bytes;
		while (this.head === undefined) {
			const end = this.headEnd ?? HEAD_LENGTH_BYTES;
			const taken = Math.min(end - this.gatheredLength, rest.length);
			this.gathered.push(rest.slice(0, taken));
			this.gatheredLength += taken;
			rest = rest.subarray(taken);
			if (this.gatheredLength < end) {
				return rest;
			}
			const whole = joined(this.gathered, this.gatheredLength);
			if (this.headEnd === undefined) {
				this.headEnd = HEAD_LENGTH_BYTES + new DataView(whole.buffer).getUint32(0);
				this.gathered = [whole];
				continue;
			}
			this.gathered = [];
			try {
				this.head = readHead(whole.subarray(HEAD_LENGTH_BYTES), this.envelope);
			} finally {
				zeroMemory(whole);
			}
			this.files = (this.head.files ?? []).map(({ name, type, size }) => ({ name, type, size }));
			this.content = this.files.reduce((sum, file) => sum + file.size, this.headEnd);
		}
		return rest;
	}

	/** Opens the stream of the file the body has reached, and of every empty one after it. */
	private async reach(): Promise<void> {
		while (this.file < this.files.length) {
			const index = this.file;
			const file = this.files[index] as NoteFileInfo;
			if (this.writers.length === index) {
				const stream = await outside(() => this.openFile({ ...file }, index));
				this.writers.push(await outside(() => stream.getWriter()));
			}
			if (this.written < file.size) {
				return;
			}
			this.file++;
			this.written = 0;
		}
	}

	/** Checks the body once its last message is open: the head, the files, the padding. */
	finish(): Format1Head {
		const { head } = this;
		if (head === undefined) {
			throw new Error("Malformed body");
		}
		if (this.file < this.files.length) {
			throw new Error("Decrypted file data does not match the declared size");
		}
		if (this.length !== sizeClass(this.content) || !this.paddingIsZeros) {
			throw new Error("Malformed padding");
		}
		return {
			...(head.text !== undefined ? { text: head.text } : {}),
			...(head.contentMode ? { contentMode: head.contentMode } : {}),
			files: this.files,
		};
	}

	/** Closes the files' streams, in order: the body is checked, the files are whole. */
	async close(): Promise<void> {
		for (const writer of this.writers) {
			await outside(() => writer.close());
		}
	}

	/** Aborts the files' streams: what they hold is not to be shown. */
	async abort(reason: unknown): Promise<void> {
		await Promise.all(this.writers.map((writer) => writer.abort(reason).catch(() => undefined)));
	}
}

/**
 * Reads a format 1 note as its messages arrive, one held at a time: the
 * stream checked tag by tag, the body read strictly, each file's bytes
 * written to the stream `openFile` opens for it. The streams are closed once
 * the last message is open and the body checked, and aborted on any failure:
 * a reader shows nothing of a note before it knows the note whole.
 */
export async function streamNoteFormat1(
	read: Format1Read,
	messages: AsyncIterable<Uint8Array>,
	openFile: OpenFile,
): Promise<Format1Head> {
	const { envelope, envelopeBytes, encryptionKey } = read;
	const body = new BodyReader(envelope, openFile);
	try {
		const state = initStreamDecrypt(envelope.streamHeader, encryptionKey);
		let count = 0;
		let ended = false;
		for await (const message of downloaded(messages)) {
			// The last message, and only it, is FINAL: secretstream authenticates
			// each message and their order, but only the tags prove none were
			// dropped from the end, or added after it.
			if (ended) {
				throw new Error("Encrypted stream is truncated or extended");
			}
			const { decrypted, isFinal, isMessage } = decryptChunk(state, message, envelopeBytes);
			try {
				if (!isFinal && !isMessage) {
					throw new Error("Encrypted stream is truncated or extended");
				}
				ended = isFinal;
				await body.push(decrypted);
			} finally {
				zeroMemory(decrypted);
			}
			count++;
		}
		if (count === 0) {
			throw new Error("No message to open");
		}
		if (!ended) {
			throw new Error("Encrypted stream is truncated or extended");
		}
		const head = body.finish();
		await body.close();
		return head;
	} catch (err) {
		await body.abort(err instanceof OutsideFailure ? err.cause : err);
		throw err;
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

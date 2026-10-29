import {
	decryptChunk as cryptoDecryptChunk,
	encryptChunk as cryptoEncryptChunk,
	decodeRawBytes,
	decryptPayload,
	deriveKeyFromPassword,
	encodeRaw,
	encryptPayload,
	fromBase64,
	generateKey,
	generateNonce,
	generateSalt,
	initSodium,
	initStreamDecrypt,
	initStreamEncrypt,
	keyFromBase64Url,
	keyToBase64Url,
	toBase64,
	zeroMemory,
} from "@largerio/secret-crypto/client";
import { SecretDecryptionError, SecretValidationError } from "./errors.js";
import type { ContentMode, NotePayload } from "./types.js";

export { sha256Hex } from "@largerio/secret-crypto/client";

function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
	const totalLen = arrays.reduce((sum, a) => sum + a.length, 0);
	const result = new Uint8Array(totalLen);
	let offset = 0;
	for (const arr of arrays) {
		result.set(arr, offset);
		offset += arr.length;
	}
	return result;
}

let initPromise: Promise<void> | undefined;

export async function ensureInit(): Promise<void> {
	if (!initPromise) {
		initPromise = initSodium();
	}
	return initPromise;
}

export interface EncryptResult {
	readonly encryptedData: string;
	readonly encryptedBytes: Uint8Array;
	readonly clientNonce: string;
	readonly keyFragment: string;
	readonly salt?: string;
}

export async function encryptNote(payload: NotePayload, password?: string): Promise<EncryptResult> {
	await ensureInit();

	const baseKey = generateKey();
	let encryptionKey: Uint8Array;
	let salt: Uint8Array | undefined;

	if (password) {
		salt = generateSalt();
		encryptionKey = deriveKeyFromPassword(password, salt, baseKey);
	} else {
		encryptionKey = baseKey;
	}

	try {
		const { ciphertext, nonce } = encryptPayload(payload, encryptionKey);

		const keyFragment = keyToBase64Url(baseKey);

		return {
			encryptedData: toBase64(ciphertext),
			encryptedBytes: ciphertext,
			clientNonce: toBase64(nonce),
			keyFragment,
			...(salt ? { salt: toBase64(salt) } : {}),
		};
	} finally {
		if (password) {
			zeroMemory(encryptionKey);
		}
		zeroMemory(baseKey);
	}
}

export async function decryptNote(
	encryptedData: string,
	clientNonce: string,
	keyFragment: string,
	password?: string,
	salt?: string,
): Promise<NotePayload> {
	return decryptNoteBytes(
		fromBase64(encryptedData),
		fromBase64(clientNonce),
		keyFragment,
		password,
		salt,
	);
}

export async function decryptNoteBytes(
	encryptedBytes: Uint8Array,
	nonceBytes: Uint8Array,
	keyFragment: string,
	password?: string,
	salt?: string,
): Promise<NotePayload> {
	await ensureInit();

	const baseKey = keyFromBase64Url(keyFragment);
	let decryptionKey: Uint8Array;

	if (password && !salt) {
		// Silently falling back to the base key here produced a generic
		// "wrong password" failure, so a proxy stripping the X-Salt header turned
		// a perfectly recoverable note into an apparently unopenable one.
		zeroMemory(baseKey);
		throw new SecretValidationError(
			"The note requires a password but the server did not return its salt",
		);
	}

	if (password && salt) {
		decryptionKey = deriveKeyFromPassword(password, fromBase64(salt), baseKey);
	} else {
		decryptionKey = baseKey;
	}

	try {
		return decryptPayload(encryptedBytes, nonceBytes, decryptionKey);
	} finally {
		if (password && salt) {
			zeroMemory(decryptionKey);
		}
		zeroMemory(baseKey);
	}
}

// --- Chunked encryption/decryption ---

export interface ChunkedEncryptResult {
	readonly header: string;
	readonly clientNonce: string;
	readonly chunks: Uint8Array[];
	readonly keyFragment: string;
	readonly salt?: string;
}

export async function encryptNoteChunked(
	payload: NotePayload,
	chunkSize: number,
	password?: string,
): Promise<ChunkedEncryptResult> {
	await ensureInit();

	const baseKey = generateKey();
	let encryptionKey: Uint8Array;
	let salt: Uint8Array | undefined;

	if (password) {
		salt = generateSalt();
		encryptionKey = deriveKeyFromPassword(password, salt, baseKey);
	} else {
		encryptionKey = baseKey;
	}

	try {
		// Initialize secretstream
		const { state, header } = initStreamEncrypt(encryptionKey);

		// Encode header chunk: text + file metadata (no file data)
		const headerPayload: StreamingHeader = {
			...(payload.text !== undefined ? { text: payload.text } : {}),
			...(payload.contentMode ? { contentMode: payload.contentMode } : {}),
			...(payload.files && payload.files.length > 0
				? {
						files: payload.files.map((f) => ({
							name: f.name,
							type: f.type,
							size: f.data.length,
						})),
					}
				: {}),
		};
		const headerBytes = encodeRaw(headerPayload);

		const chunks: Uint8Array[] = [];
		// An empty file gets no chunk, so the stream ends on the last chunk of
		// the last file with data, which need not be the last file.
		let lastFileWithData = -1;
		for (const [fi, file] of (payload.files ?? []).entries()) {
			if (file.data.length > 0) lastFileWithData = fi;
		}
		const hasMoreData = lastFileWithData !== -1;

		// Encrypt header chunk (only final if no file data follows)
		chunks.push(cryptoEncryptChunk(state, headerBytes, !hasMoreData));

		// Stream file data chunk by chunk (never hold more than chunkSize in memory)
		if (payload.files && hasMoreData) {
			for (const [fi, file] of payload.files.entries()) {
				for (let offset = 0; offset < file.data.length; offset += chunkSize) {
					const end = Math.min(offset + chunkSize, file.data.length);
					const slice = file.data.subarray(offset, end);
					const isLastChunk = fi === lastFileWithData && end >= file.data.length;
					chunks.push(cryptoEncryptChunk(state, slice, isLastChunk));
				}
			}
		}

		const keyFragment = keyToBase64Url(baseKey);

		return {
			header: toBase64(header),
			// Chunked notes authenticate via the secretstream `header` above, not a
			// standalone nonce. This value is a placeholder that exists only to
			// satisfy the shared create schema and the NOT NULL `client_nonce`
			// column; it is never consumed when reading a chunked note
			// (see decryptNoteChunked / readNoteStream).
			clientNonce: toBase64(generateNonce()),
			chunks,
			keyFragment,
			...(salt ? { salt: toBase64(salt) } : {}),
		};
	} finally {
		if (password) {
			zeroMemory(encryptionKey);
		}
		zeroMemory(baseKey);
	}
}

// Streaming header: file metadata without data bytes
interface StreamingFileHeader {
	readonly name: string;
	readonly type: string;
	readonly size: number;
}

interface StreamingHeader {
	readonly text?: string;
	readonly contentMode?: ContentMode;
	readonly files?: ReadonlyArray<StreamingFileHeader>;
}

const CONTENT_MODES: ReadonlySet<string> = new Set(["text", "markdown", "secret"]);

/**
 * The non-chunked path validates its decoded payload (`isNotePayload`); this one
 * used to cast. The stream is authenticated, so a third party cannot forge it —
 * but the *sender* controls the plaintext and can emit an arbitrary MessagePack
 * header, which then flowed into the payload untyped.
 */
function isStreamingHeader(value: unknown): value is StreamingHeader {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;

	if (v["text"] !== undefined && typeof v["text"] !== "string") return false;
	if (v["contentMode"] !== undefined && !CONTENT_MODES.has(v["contentMode"] as string))
		return false;
	if (v["files"] === undefined) return true;
	if (!Array.isArray(v["files"])) return false;

	return v["files"].every((f: unknown) => {
		if (typeof f !== "object" || f === null) return false;
		const file = f as Record<string, unknown>;
		return (
			typeof file["name"] === "string" &&
			typeof file["type"] === "string" &&
			typeof file["size"] === "number"
		);
	});
}

export async function decryptNoteChunked(
	encryptedChunks: Uint8Array[],
	streamHeader: string,
	keyFragment: string,
	password?: string,
	salt?: string,
): Promise<NotePayload> {
	await ensureInit();

	const baseKey = keyFromBase64Url(keyFragment);
	let decryptionKey: Uint8Array;

	if (password && !salt) {
		// Silently falling back to the base key here produced a generic
		// "wrong password" failure, so a proxy stripping the X-Salt header turned
		// a perfectly recoverable note into an apparently unopenable one.
		zeroMemory(baseKey);
		throw new SecretValidationError(
			"The note requires a password but the server did not return its salt",
		);
	}

	if (password && salt) {
		decryptionKey = deriveKeyFromPassword(password, fromBase64(salt), baseKey);
	} else {
		decryptionKey = baseKey;
	}

	try {
		const state = initStreamDecrypt(fromBase64(streamHeader), decryptionKey);

		// Decrypt header chunk (first chunk)
		const firstChunk = encryptedChunks[0];
		if (!firstChunk) {
			throw new Error("No chunks to decrypt");
		}
		const { decrypted: headerBytes, isFinal: headerIsFinal } = cryptoDecryptChunk(
			state,
			firstChunk,
		);

		// Decode header to get file metadata
		const decoded = decodeRawBytes(headerBytes);
		if (!isStreamingHeader(decoded)) {
			throw new SecretDecryptionError();
		}
		const headerData = decoded;
		const fileMeta = headerData.files ?? [];

		// The stream must end on its FINAL chunk, and nothing may follow it.
		// secretstream authenticates every chunk and their order, but only the
		// FINAL tag proves none were dropped from the end: without this check a
		// server serving the header chunk alone handed back empty files.
		const isLastChunk = encryptedChunks.length === 1;
		if (headerIsFinal !== isLastChunk) {
			throw new Error("Encrypted stream is truncated or extended");
		}

		// The header was the only chunk (text-only note or note with 0-byte files)
		if (headerIsFinal) {
			if (fileMeta.some((f) => f.size > 0)) {
				throw new Error("Encrypted stream is truncated or extended");
			}
			return buildPayload(
				headerData,
				fileMeta.map((f) => ({
					name: f.name,
					type: f.type,
					size: f.size,
					data: new Uint8Array(0),
				})),
			);
		}

		// Decrypt remaining chunks and concatenate all file bytes
		const dataChunks: Uint8Array[] = [];
		const lastIndex = encryptedChunks.length - 1;
		for (const [index, chunk] of encryptedChunks.entries()) {
			if (index === 0) continue;
			const { decrypted, isFinal } = cryptoDecryptChunk(state, chunk);
			if (isFinal !== (index === lastIndex)) {
				throw new Error("Encrypted stream is truncated or extended");
			}
			dataChunks.push(decrypted);
		}

		const totalData = concatUint8Arrays(dataChunks);

		// Distribute bytes to files based on metadata sizes. subarray() clamps
		// silently if the decrypted stream is shorter than the header claims, so
		// validate each slice length explicitly (defense in depth — the stream
		// is already authenticated) rather than returning truncated file data.
		let byteOffset = 0;
		const files = fileMeta.map((meta) => {
			const data = totalData.subarray(byteOffset, byteOffset + meta.size);
			if (data.length !== meta.size) {
				throw new Error("Decrypted file data does not match the declared size");
			}
			byteOffset += meta.size;
			return { name: meta.name, type: meta.type, size: meta.size, data };
		});

		return buildPayload(headerData, files);
	} finally {
		if (password && salt) {
			zeroMemory(decryptionKey);
		}
		zeroMemory(baseKey);
	}
}

function buildPayload(
	header: StreamingHeader,
	files: Array<{ name: string; type: string; size: number; data: Uint8Array }>,
): NotePayload {
	return {
		...(header.text !== undefined ? { text: header.text } : {}),
		...(header.contentMode ? { contentMode: header.contentMode } : {}),
		...(files.length > 0 ? { files } : {}),
	};
}

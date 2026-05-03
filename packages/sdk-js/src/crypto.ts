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
} from "@secret/crypto/client";
import type { ContentMode, NotePayload } from "@secret/shared";

function concatBytes(arrays: Uint8Array[]): Uint8Array {
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
		const hasMoreData =
			payload.files !== undefined &&
			payload.files.length > 0 &&
			payload.files.some((f) => f.data.length > 0);

		// Encrypt header chunk (only final if no file data follows)
		chunks.push(cryptoEncryptChunk(state, headerBytes, !hasMoreData));

		// Stream file data chunk by chunk (never hold more than chunkSize in memory)
		if (payload.files && hasMoreData) {
			for (const [fi, file] of payload.files.entries()) {
				for (let offset = 0; offset < file.data.length; offset += chunkSize) {
					const end = Math.min(offset + chunkSize, file.data.length);
					const slice = file.data.subarray(offset, end);
					const isLastChunkOfLastFile = fi === payload.files.length - 1 && end >= file.data.length;
					chunks.push(cryptoEncryptChunk(state, slice, isLastChunkOfLastFile));
				}
			}
		}

		const keyFragment = keyToBase64Url(baseKey);

		return {
			header: toBase64(header),
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
		const headerData = decoded as StreamingHeader;
		const fileMeta = headerData.files ?? [];

		// If header was the only chunk (text-only note or note with 0-byte files)
		if (headerIsFinal || encryptedChunks.length === 1) {
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
		for (const chunk of encryptedChunks.slice(1)) {
			const { decrypted } = cryptoDecryptChunk(state, chunk);
			dataChunks.push(decrypted);
		}

		const totalData = concatBytes(dataChunks);

		// Distribute bytes to files based on metadata sizes
		let byteOffset = 0;
		const files = fileMeta.map((meta) => {
			const data = totalData.subarray(byteOffset, byteOffset + meta.size);
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

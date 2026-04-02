import {
	decryptChunk as cryptoDecryptChunk,
	encryptChunk as cryptoEncryptChunk,
	decodeRawBytes,
	decryptPayload,
	deriveKeyFromPassword,
	encodePayload,
	encryptPayload,
	fromBase64,
	generateKey,
	generateSalt,
	initSodium,
	initStreamDecrypt,
	initStreamEncrypt,
	keyFromBase64Url,
	keyToBase64Url,
	toBase64,
	zeroMemory,
} from "@secret/crypto/client";
import type { NotePayload } from "@secret/shared";

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

	const { ciphertext, nonce } = encryptPayload(payload, encryptionKey);

	const keyFragment = keyToBase64Url(baseKey);

	const result: EncryptResult = {
		encryptedData: toBase64(ciphertext),
		encryptedBytes: ciphertext,
		clientNonce: toBase64(nonce),
		keyFragment,
		...(salt ? { salt: toBase64(salt) } : {}),
	};

	if (password) {
		zeroMemory(encryptionKey);
	}
	zeroMemory(baseKey);

	return result;
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

	const result = decryptPayload(encryptedBytes, nonceBytes, decryptionKey);

	if (password && salt) {
		zeroMemory(decryptionKey);
	}
	zeroMemory(baseKey);

	return result;
}

// --- Chunked encryption/decryption ---

export interface ChunkedEncryptResult {
	readonly header: string;
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
	const headerBytes = encodePayload(headerPayload as NotePayload);

	const chunks: Uint8Array[] = [];
	const hasMoreData =
		payload.files !== undefined &&
		payload.files.length > 0 &&
		payload.files.some((f) => f.data.length > 0);

	// Encrypt header chunk (only final if no file data follows)
	chunks.push(cryptoEncryptChunk(state, headerBytes, !hasMoreData));

	// Stream file data chunk by chunk (never hold more than chunkSize in memory)
	if (payload.files && hasMoreData) {
		const allFiles = payload.files;
		for (let fi = 0; fi < allFiles.length; fi++) {
			const file = allFiles[fi];
			if (!file) continue;
			const data = file.data;
			for (let offset = 0; offset < data.length; offset += chunkSize) {
				const end = Math.min(offset + chunkSize, data.length);
				const slice = data.subarray(offset, end);
				const isLastChunkOfLastFile = fi === allFiles.length - 1 && end >= data.length;
				chunks.push(cryptoEncryptChunk(state, slice, isLastChunkOfLastFile));
			}
		}
	}

	const keyFragment = keyToBase64Url(baseKey);

	if (password) {
		zeroMemory(encryptionKey);
	}
	zeroMemory(baseKey);

	return {
		header: toBase64(header),
		chunks,
		keyFragment,
		...(salt ? { salt: toBase64(salt) } : {}),
	};
}

// Streaming header: file metadata without data bytes
interface StreamingFileHeader {
	readonly name: string;
	readonly type: string;
	readonly size: number;
}

interface StreamingHeader {
	readonly text?: string;
	readonly contentMode?: string;
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

	const state = initStreamDecrypt(fromBase64(streamHeader), decryptionKey);

	// Decrypt header chunk (first chunk)
	const firstChunk = encryptedChunks[0];
	if (!firstChunk) {
		throw new Error("No chunks to decrypt");
	}
	const { decrypted: headerBytes, isFinal: headerIsFinal } = cryptoDecryptChunk(state, firstChunk);

	// Decode header to get file metadata
	const decoded = decodeRawBytes(headerBytes);
	const headerData = decoded as StreamingHeader;
	const fileMeta = headerData.files ?? [];

	// If header was the only chunk (text-only note or note with 0-byte files)
	if (headerIsFinal || encryptedChunks.length === 1) {
		if (password && salt) zeroMemory(decryptionKey);
		zeroMemory(baseKey);

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

	// Decrypt remaining chunks and distribute bytes to files
	const fileDataBuffers: Uint8Array[][] = fileMeta.map(() => []);
	let currentFileIndex = 0;
	let currentFileRemaining = fileMeta[0]?.size ?? 0;

	for (let i = 1; i < encryptedChunks.length; i++) {
		const chunk = encryptedChunks[i];
		if (!chunk) break;
		const { decrypted } = cryptoDecryptChunk(state, chunk);

		// Distribute decrypted bytes across files
		let offset = 0;
		while (offset < decrypted.length && currentFileIndex < fileMeta.length) {
			const take = Math.min(decrypted.length - offset, currentFileRemaining);
			const buffers = fileDataBuffers[currentFileIndex];
			if (buffers) {
				buffers.push(decrypted.subarray(offset, offset + take));
			}
			offset += take;
			currentFileRemaining -= take;

			if (currentFileRemaining <= 0) {
				currentFileIndex++;
				currentFileRemaining = fileMeta[currentFileIndex]?.size ?? 0;
			}
		}
	}

	if (password && salt) zeroMemory(decryptionKey);
	zeroMemory(baseKey);

	// Assemble files from buffers
	const files = fileMeta.map((meta, idx) => {
		const buffers = fileDataBuffers[idx] ?? [];
		const totalLen = buffers.reduce((sum, b) => sum + b.length, 0);
		const assembled = new Uint8Array(totalLen);
		let off = 0;
		for (const buf of buffers) {
			assembled.set(buf, off);
			off += buf.length;
		}
		return { name: meta.name, type: meta.type, size: meta.size, data: assembled };
	});

	return buildPayload(headerData, files);
}

function buildPayload(
	header: StreamingHeader,
	files: Array<{ name: string; type: string; size: number; data: Uint8Array }>,
): NotePayload {
	const result: NotePayload = {};
	if (header.text !== undefined) {
		(result as { text: string }).text = header.text;
	}
	if (header.contentMode) {
		(result as { contentMode: string }).contentMode = header.contentMode;
	}
	if (files.length > 0) {
		(result as { files: typeof files }).files = files;
	}
	return result;
}

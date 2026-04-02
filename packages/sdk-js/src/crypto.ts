import {
	decryptChunk as cryptoDecryptChunk,
	encryptChunk as cryptoEncryptChunk,
	decodePayloadBytes,
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

	// MessagePack encode the payload
	const encoded = encodePayload(payload);

	// Initialize secretstream
	const { state, header } = initStreamEncrypt(encryptionKey);

	// Split into chunks and encrypt each
	const chunks: Uint8Array[] = [];

	/* v8 ignore next 3 -- MessagePack encode always produces at least 1 byte */
	if (encoded.length === 0) {
		chunks.push(cryptoEncryptChunk(state, new Uint8Array(0), true));
	} else {
		for (let offset = 0; offset < encoded.length; offset += chunkSize) {
			const end = Math.min(offset + chunkSize, encoded.length);
			const chunk = encoded.slice(offset, end);
			const isFinal = end >= encoded.length;
			const encrypted = cryptoEncryptChunk(state, chunk, isFinal);
			chunks.push(encrypted);
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

	const decryptedParts: Uint8Array[] = [];
	for (const chunk of encryptedChunks) {
		const { decrypted } = cryptoDecryptChunk(state, chunk);
		decryptedParts.push(decrypted);
	}

	if (password && salt) {
		zeroMemory(decryptionKey);
	}
	zeroMemory(baseKey);

	// Reassemble and decode MessagePack
	const totalLength = decryptedParts.reduce((sum, p) => sum + p.length, 0);
	const combined = new Uint8Array(totalLength);
	let offset = 0;
	for (const part of decryptedParts) {
		combined.set(part, offset);
		offset += part.length;
	}

	return decodePayloadBytes(combined);
}

import {
	decryptPayload,
	deriveKeyFromPassword,
	encryptPayload,
	fromBase64,
	generateKey,
	generateSalt,
	initSodium,
	keyFromBase64Url,
	keyToBase64Url,
	toBase64,
	zeroMemory,
} from "@secret/crypto/client";
import type { NotePayload } from "@secret/shared";

let initialized = false;

export async function ensureInit(): Promise<void> {
	if (!initialized) {
		await initSodium();
		initialized = true;
	}
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

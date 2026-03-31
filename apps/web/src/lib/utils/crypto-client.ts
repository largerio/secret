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

async function ensureInit(): Promise<void> {
	if (!initialized) {
		await initSodium();
		initialized = true;
	}
}

export interface EncryptResult {
	readonly encryptedData: string;
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

	const result: EncryptResult = {
		encryptedData: toBase64(ciphertext),
		clientNonce: toBase64(nonce),
		keyFragment: keyToBase64Url(baseKey),
		...(salt ? { salt: toBase64(salt) } : {}),
	};

	if (password) {
		zeroMemory(encryptionKey);
	}

	return result;
}

export async function decryptNote(
	encryptedData: string,
	clientNonce: string,
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

	const result = decryptPayload(fromBase64(encryptedData), fromBase64(clientNonce), decryptionKey);

	if (password && salt) {
		zeroMemory(decryptionKey);
	}

	return result;
}

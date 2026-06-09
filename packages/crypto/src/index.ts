/**
 * Full crypto surface: client (XChaCha20-Poly1305) + server (AES-256-GCM).
 *
 * Three entry points are published so callers pull in only what they need:
 *  - `@largerio/secret-crypto`        — this barrel: client + server primitives (backend).
 *  - `@largerio/secret-crypto/client` — client-only, plus the MessagePack decode helpers
 *                              (`decodePayloadBytes`/`decodeRawBytes`); excludes
 *                              server code so the browser bundle stays lean.
 *  - `@largerio/secret-crypto/server` — server-only (AES-256-GCM) primitives.
 */
export type { DecryptChunkResult } from "./decrypt.js";
export { decryptChunk, decryptPayload, decryptRaw, initStreamDecrypt } from "./decrypt.js";
export type { EncryptedNote, StreamEncryptState } from "./encrypt.js";
export {
	encodeRaw,
	encryptChunk,
	encryptPayload,
	encryptRaw,
	initStreamEncrypt,
	SECRETSTREAM_ABYTES,
	SECRETSTREAM_HEADERBYTES,
} from "./encrypt.js";
export {
	deriveKeyFromPassword,
	fromBase64,
	generateKey,
	generateNonce,
	generateSalt,
	initSodium,
	keyFromBase64Url,
	keyToBase64Url,
	toBase64,
	zeroMemory,
} from "./keys.js";
export { generateServerKey, parseServerKey, serverDecrypt, serverEncrypt } from "./server.js";

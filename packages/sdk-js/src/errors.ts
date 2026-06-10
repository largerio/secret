export class SecretApiError extends Error {
	readonly status: number;

	constructor(message: string, status: number) {
		super(message);
		this.name = "SecretApiError";
		this.status = status;
	}
}

/**
 * Thrown by createNote before any encryption or network work when the options
 * exceed protocol-level limits the server is guaranteed to reject, so callers
 * fail fast instead of after a full encrypt + upload round-trip.
 */
export class SecretValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SecretValidationError";
	}
}

/**
 * Thrown whenever a note cannot be decrypted. The cause is intentionally
 * uniform — a wrong password/key and tampered/corrupted ciphertext both
 * surface as this single error with the same message, so callers cannot
 * distinguish the two (avoids a password-oracle).
 */
export class SecretDecryptionError extends Error {
	constructor(message = "Unable to decrypt: wrong password/key or corrupted data") {
		super(message);
		this.name = "SecretDecryptionError";
	}
}

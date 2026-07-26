/**
 * Thrown when the request never produced an HTTP response: DNS failure, offline
 * client, connection reset, CORS rejection. Kept distinct from
 * {@link SecretApiError} (which always carries a server status) so a caller can
 * offer "retry" for a transport problem without mistaking it for a rejection.
 */
export class SecretNetworkError extends Error {
	/** @param options Standard `Error` options; `cause` carries the original failure. */
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "SecretNetworkError";
	}
}

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

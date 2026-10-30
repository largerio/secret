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

/** What an instance's error answer says besides its status (PROTOCOL.md, "Errors"). */
export interface SecretApiErrorDetails {
	readonly code?: string | undefined;
	readonly retryAfter?: number | undefined;
}

export class SecretApiError extends Error {
	readonly status: number;
	/**
	 * The instance's name for the error, such as `note_not_found` or
	 * `rate_limited` (PROTOCOL.md, "Errors"): branch on it rather than on the
	 * message. Absent when the answer did not come from the instance (a proxy
	 * or a firewall in front of it), or came from one older than 1.7.0.
	 */
	readonly code?: string;
	/** A `429`'s `Retry-After`: seconds to wait before sending the request again. */
	readonly retryAfter?: number;

	constructor(message: string, status: number, details?: SecretApiErrorDetails) {
		super(message);
		this.name = "SecretApiError";
		this.status = status;
		if (details?.code !== undefined) {
			this.code = details.code;
		}
		if (details?.retryAfter !== undefined) {
			this.retryAfter = details.retryAfter;
		}
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

/**
 * The error an answer carries (PROTOCOL.md, "Errors"): the instance's message
 * and code when the body is its problem details, `HTTP <status>` and no code
 * when it is not (a proxy's page, say).
 */
export function apiErrorOf(
	body: unknown,
	status: number,
	retryAfter: string | null,
): SecretApiError {
	const fields = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
	const error = fields["error"];
	const code = fields["code"];
	return new SecretApiError(typeof error === "string" ? error : `HTTP ${String(status)}`, status, {
		code: typeof code === "string" ? code : undefined,
		// Seconds; the HTTP-date form is not one an instance sends.
		retryAfter: retryAfter !== null && /^\d+$/.test(retryAfter) ? Number(retryAfter) : undefined,
	});
}

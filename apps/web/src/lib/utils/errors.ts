import { SecretApiError, SecretNetworkError } from "@largerio/secret-sdk";
import { type MessageKey, t } from "#lib/i18n/index.svelte.js";

/**
 * Whether the server could not be asked at all, or could not answer: no
 * connection, the SDK's timeout (status 0), a server error. A request like
 * this may still have reached the server.
 */
export function isUnreachable(error: unknown): boolean {
	if (error instanceof SecretNetworkError) return true;
	return error instanceof SecretApiError && (error.status === 0 || error.status >= 500);
}

function messageKey(error: unknown): MessageKey {
	if (!(error instanceof SecretApiError)) {
		return error instanceof SecretNetworkError ? "error_network" : "error_generic";
	}
	switch (error.status) {
		case 0:
			return "error_network";
		case 401:
			// The proof-of-work token every write carries: a retry solves a new one.
			return "error_check_failed";
		case 413:
			return "error_too_large";
		case 429:
			return "error_rate_limited";
		case 507:
			return "error_storage_full";
		default:
			return error.status >= 500 ? "error_server" : "error_generic";
	}
}

/**
 * What to tell someone whose request failed, in their language. The SDK's
 * own messages are the server's, in English and meant for developers ("Too
 * many requests", "Network request failed").
 */
export function requestErrorMessage(error: unknown): string {
	return t(messageKey(error));
}

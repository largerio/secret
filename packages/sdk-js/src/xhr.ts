import type { CreateNoteResponse } from "@largerio/secret-shared";
import { SecretApiError, SecretNetworkError } from "./errors.js";

// A hand-written guard rather than shared's `createNoteResponseSchema`: that
// one import pulled all of zod into the published bundle (~94% of it).
function isCreateNoteResponse(value: unknown): value is CreateNoteResponse {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v["id"] === "string" &&
		typeof v["expiresAt"] === "string" &&
		typeof v["deleteToken"] === "string"
	);
}

export function postFormDataXhr(
	url: string,
	headers: Record<string, string>,
	formData: FormData,
	onProgress: (progress: number) => void,
	timeoutMs?: number,
): Promise<CreateNoteResponse> {
	return new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		xhr.open("POST", url);

		if (timeoutMs !== undefined) {
			xhr.timeout = timeoutMs;
			xhr.addEventListener("timeout", () => reject(new SecretApiError("Upload timed out", 0)));
		}

		for (const [name, value] of Object.entries(headers)) {
			xhr.setRequestHeader(name, value);
		}

		xhr.upload.addEventListener("progress", (e) => {
			if (e.lengthComputable) {
				onProgress(e.loaded / e.total);
			}
		});

		xhr.addEventListener("load", () => {
			let data: Record<string, unknown>;
			try {
				data = JSON.parse(xhr.responseText) as Record<string, unknown>;
			} catch {
				reject(new SecretApiError("Invalid JSON response", xhr.status));
				return;
			}

			if (xhr.status >= 200 && xhr.status < 300) {
				// Validate the success shape at runtime rather than trusting the cast —
				// a malformed 2xx body should fail loudly instead of propagating.
				if (!isCreateNoteResponse(data)) {
					reject(new SecretApiError("Invalid response", xhr.status));
					return;
				}
				resolve(data);
			} else {
				const error =
					typeof data["error"] === "string" ? data["error"] : `HTTP ${String(xhr.status)}`;
				reject(new SecretApiError(error, xhr.status));
			}
		});

		// Same contract as the fetch path: a request that never got a response is a
		// SecretNetworkError, which callers can tell from a server rejection.
		xhr.addEventListener("error", () => reject(new SecretNetworkError("Network request failed")));
		xhr.addEventListener("abort", () => reject(new SecretApiError("Upload cancelled", 0)));

		xhr.send(formData);
	});
}

export function isXhrAvailable(): boolean {
	return typeof XMLHttpRequest !== "undefined";
}

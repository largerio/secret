import { type CreateNoteResponse, createNoteResponseSchema } from "@largerio/secret-shared";
import { SecretApiError } from "./errors.js";

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
				const parsed = createNoteResponseSchema.safeParse(data);
				if (!parsed.success) {
					reject(new SecretApiError("Invalid response", xhr.status));
					return;
				}
				resolve(parsed.data);
			} else {
				const error =
					typeof data["error"] === "string" ? data["error"] : `HTTP ${String(xhr.status)}`;
				reject(new SecretApiError(error, xhr.status));
			}
		});

		xhr.addEventListener("error", () => reject(new SecretApiError("Network error", 0)));
		xhr.addEventListener("abort", () => reject(new SecretApiError("Upload cancelled", 0)));

		xhr.send(formData);
	});
}

export function isXhrAvailable(): boolean {
	return typeof XMLHttpRequest !== "undefined";
}

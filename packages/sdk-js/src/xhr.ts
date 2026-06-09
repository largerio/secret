import type { CreateNoteResponse } from "@largerio/shared";
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
			try {
				const data = JSON.parse(xhr.responseText) as Record<string, unknown>;
				if (xhr.status >= 200 && xhr.status < 300) {
					resolve(data as unknown as CreateNoteResponse);
				} else {
					const error =
						typeof data["error"] === "string" ? data["error"] : `HTTP ${String(xhr.status)}`;
					reject(new SecretApiError(error, xhr.status));
				}
			} catch {
				reject(new SecretApiError("Invalid JSON response", xhr.status));
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

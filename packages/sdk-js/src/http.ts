import type { CreateNoteResponse, NoteExistsResponse, ReadNoteResponse } from "@secret/shared";
import { SecretApiError } from "./errors.js";

export interface HttpClientConfig {
	readonly baseUrl: string;
	readonly fetch: typeof fetch;
	readonly apiKey?: string;
}

function authHeaders(apiKey?: string, capToken?: string): Record<string, string> {
	const headers: Record<string, string> = {};

	if (apiKey) {
		headers["Authorization"] = `Bearer ${apiKey}`;
	}
	if (capToken) {
		headers["X-Cap-Token"] = capToken;
	}

	return headers;
}

async function handleResponse<T>(res: Response): Promise<T> {
	if (!res.ok) {
		const body = await res.json().catch(() => ({ error: "Request failed" }));
		throw new SecretApiError(
			((body as Record<string, unknown>)["error"] as string) ?? `HTTP ${String(res.status)}`,
			res.status,
		);
	}

	return res.json() as Promise<T>;
}

export async function postJson(
	config: HttpClientConfig,
	path: string,
	body: unknown,
	capToken?: string,
): Promise<CreateNoteResponse> {
	const res = await config.fetch(`${config.baseUrl}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...authHeaders(config.apiKey, capToken) },
		body: JSON.stringify(body),
	});

	return handleResponse<CreateNoteResponse>(res);
}

export function postFormData(
	config: HttpClientConfig,
	path: string,
	formData: FormData,
	onProgress?: (progress: number) => void,
	capToken?: string,
): Promise<CreateNoteResponse> {
	if (onProgress && typeof XMLHttpRequest !== "undefined") {
		return postFormDataXhr(config, path, formData, onProgress, capToken);
	}

	return postFormDataFetch(config, path, formData, capToken);
}

async function postFormDataFetch(
	config: HttpClientConfig,
	path: string,
	formData: FormData,
	capToken?: string,
): Promise<CreateNoteResponse> {
	const res = await config.fetch(`${config.baseUrl}${path}`, {
		method: "POST",
		headers: authHeaders(config.apiKey, capToken),
		body: formData,
	});

	return handleResponse<CreateNoteResponse>(res);
}

function postFormDataXhr(
	config: HttpClientConfig,
	path: string,
	formData: FormData,
	onProgress: (progress: number) => void,
	capToken?: string,
): Promise<CreateNoteResponse> {
	return new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		xhr.open("POST", `${config.baseUrl}${path}`);

		const headers = authHeaders(config.apiKey, capToken);
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
					reject(
						new SecretApiError(
							(data["error"] as string) ?? `HTTP ${String(xhr.status)}`,
							xhr.status,
						),
					);
				}
			} catch {
				reject(new SecretApiError("Invalid response", 0));
			}
		});

		xhr.addEventListener("error", () => reject(new SecretApiError("Network error", 0)));
		xhr.addEventListener("abort", () => reject(new SecretApiError("Upload cancelled", 0)));

		xhr.send(formData);
	});
}

export async function getJson<T>(
	config: HttpClientConfig,
	path: string,
	onProgress?: (progress: number) => void,
): Promise<T> {
	const res = await config.fetch(`${config.baseUrl}${path}`, {
		headers: authHeaders(config.apiKey),
	});

	if (!res.ok) {
		const body = await res.json().catch(() => ({ error: "Request failed" }));
		throw new SecretApiError(
			((body as Record<string, unknown>)["error"] as string) ?? `HTTP ${String(res.status)}`,
			res.status,
		);
	}

	if (onProgress && res.body) {
		const contentLength = res.headers.get("content-length");
		const total = contentLength ? parseInt(contentLength, 10) : 0;

		if (total > 0) {
			const reader = res.body.getReader();
			const chunks: Uint8Array[] = [];
			let loaded = 0;

			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				chunks.push(value);
				loaded += value.length;
				onProgress(loaded / total);
			}

			const combined = await new Blob(chunks as BlobPart[]).arrayBuffer();
			const text = new TextDecoder().decode(combined);
			return JSON.parse(text) as T;
		}
	}

	return res.json() as Promise<T>;
}

export async function getNote(
	config: HttpClientConfig,
	id: string,
	onProgress?: (progress: number) => void,
): Promise<ReadNoteResponse> {
	return getJson<ReadNoteResponse>(config, `/notes/${id}`, onProgress);
}

export async function checkNote(config: HttpClientConfig, id: string): Promise<NoteExistsResponse> {
	const res = await config.fetch(`${config.baseUrl}/notes/${id}/exists`, {
		headers: authHeaders(config.apiKey),
	});

	if (!res.ok) {
		return { exists: false, hasPassword: false, fileCount: 0, expiresAt: "", maxReads: 1 };
	}

	return res.json() as Promise<NoteExistsResponse>;
}

export async function deleteNote(
	config: HttpClientConfig,
	id: string,
	deleteToken: string,
	capToken?: string,
): Promise<void> {
	const res = await config.fetch(`${config.baseUrl}/notes/${id}`, {
		method: "DELETE",
		headers: { "X-Delete-Token": deleteToken, ...authHeaders(config.apiKey, capToken) },
	});

	if (!res.ok) {
		const body = await res.json().catch(() => ({ error: "Request failed" }));
		throw new SecretApiError(
			((body as Record<string, unknown>)["error"] as string) ?? `HTTP ${String(res.status)}`,
			res.status,
		);
	}
}

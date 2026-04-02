import type { CreateNoteResponse, NoteExistsResponse, ReadNoteResponse } from "@secret/shared";
import { SecretApiError } from "./errors.js";

const UINT32_SIZE = 4;
const MAX_REASONABLE_CHUNK_SIZE = 100 * 1024 * 1024; // 100MB sanity limit

function extractErrorMessage(body: unknown, status: number): string {
	if (typeof body === "object" && body !== null && "error" in body) {
		const error = (body as Record<string, unknown>)["error"];
		if (typeof error === "string") return error;
	}
	return `HTTP ${String(status)}`;
}

function getRequiredHeader(headers: Headers, name: string): string {
	const value = headers.get(name);
	if (!value) {
		throw new SecretApiError(`Missing required header: ${name}`, 502);
	}
	return value;
}

function parsePositiveInt(value: string | null, defaultVal: number): number {
	if (!value) return defaultVal;
	const parsed = parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed < 0) return defaultVal;
	return parsed;
}

function safeAtob(base64: string): Uint8Array {
	try {
		return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
	} catch {
		throw new SecretApiError("Invalid base64 encoding in response", 502);
	}
}

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
		const body = await res.json().catch(() => ({}));
		throw new SecretApiError(extractErrorMessage(body, res.status), res.status);
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
					reject(new SecretApiError(extractErrorMessage(data, xhr.status), xhr.status));
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

export async function getJson<T>(
	config: HttpClientConfig,
	path: string,
	onProgress?: (progress: number) => void,
): Promise<T> {
	const res = await config.fetch(`${config.baseUrl}${path}`, {
		headers: authHeaders(config.apiKey),
	});

	if (!res.ok) {
		const body = await res.json().catch(() => ({}));
		throw new SecretApiError(extractErrorMessage(body, res.status), res.status);
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

export interface RawNoteResponse {
	readonly encryptedBytes: Uint8Array;
	readonly nonceBytes: Uint8Array;
	readonly hasPassword: boolean;
	readonly fileCount: number;
	readonly createdAt: string;
	readonly expiresAt: string;
	readonly salt?: string;
}

export async function getNoteRaw(
	config: HttpClientConfig,
	id: string,
	onProgress?: (progress: number) => void,
): Promise<RawNoteResponse> {
	const res = await config.fetch(`${config.baseUrl}/notes/${id}/raw`, {
		headers: authHeaders(config.apiKey),
	});

	if (!res.ok) {
		const body = await res.json().catch(() => ({}));
		throw new SecretApiError(extractErrorMessage(body, res.status), res.status);
	}

	const headers = res.headers;
	const clientNonce = getRequiredHeader(headers, "X-Client-Nonce");
	const hasPassword = headers.get("X-Has-Password") === "true";
	const fileCount = parsePositiveInt(headers.get("X-File-Count"), 0);
	const createdAt = getRequiredHeader(headers, "X-Created-At");
	const expiresAt = getRequiredHeader(headers, "X-Expires-At");
	const salt = headers.get("X-Salt") ?? undefined;

	let data: ArrayBuffer;
	if (onProgress && res.body) {
		const contentLength = headers.get("Content-Length");
		const total = parsePositiveInt(contentLength, 0);

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

			data = await new Blob(chunks as BlobPart[]).arrayBuffer();
		} else {
			data = await res.arrayBuffer();
		}
	} else {
		data = await res.arrayBuffer();
	}

	const nonceBytes = safeAtob(clientNonce);

	return {
		encryptedBytes: new Uint8Array(data),
		nonceBytes,
		hasPassword,
		fileCount,
		createdAt,
		expiresAt,
		...(salt ? { salt } : {}),
	};
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
		const body = await res.json().catch(() => ({}));
		throw new SecretApiError(extractErrorMessage(body, res.status), res.status);
	}
}

// --- Chunked upload HTTP functions ---

export interface ChunkedUploadInitResult {
	readonly uploadId: string;
	readonly expiresAt: string;
}

export async function initChunkedUpload(
	config: HttpClientConfig,
	metadata: Record<string, unknown>,
	capToken?: string,
): Promise<ChunkedUploadInitResult> {
	const res = await config.fetch(`${config.baseUrl}/notes/upload/init`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...authHeaders(config.apiKey, capToken) },
		body: JSON.stringify(metadata),
	});
	return handleResponse<ChunkedUploadInitResult>(res);
}

export async function uploadChunk(
	config: HttpClientConfig,
	uploadId: string,
	index: number,
	data: Uint8Array,
	hash: string,
): Promise<void> {
	const res = await config.fetch(
		`${config.baseUrl}/notes/upload/${uploadId}/chunks/${String(index)}`,
		{
			method: "PUT",
			headers: {
				"Content-Type": "application/octet-stream",
				"X-Chunk-Hash": hash,
				...authHeaders(config.apiKey),
			},
			body: data as BodyInit,
		},
	);
	if (!res.ok) {
		const body = await res.json().catch(() => ({}));
		throw new SecretApiError(extractErrorMessage(body, res.status), res.status);
	}
}

export async function completeChunkedUpload(
	config: HttpClientConfig,
	uploadId: string,
	capToken?: string,
): Promise<CreateNoteResponse> {
	const res = await config.fetch(`${config.baseUrl}/notes/upload/${uploadId}/complete`, {
		method: "POST",
		headers: authHeaders(config.apiKey, capToken),
	});
	return handleResponse<CreateNoteResponse>(res);
}

// --- Chunked download HTTP function ---

export interface StreamNoteResponse {
	readonly streamHeader: string;
	readonly chunkCount: number;
	readonly hasPassword: boolean;
	readonly fileCount: number;
	readonly createdAt: string;
	readonly expiresAt: string;
	readonly salt?: string;
	readonly chunks: Uint8Array[];
}

export async function getNoteStream(
	config: HttpClientConfig,
	id: string,
	onProgress?: (progress: number) => void,
): Promise<StreamNoteResponse> {
	const res = await config.fetch(`${config.baseUrl}/notes/${id}/stream`, {
		headers: authHeaders(config.apiKey),
	});

	if (!res.ok) {
		const body = await res.json().catch(() => ({}));
		throw new SecretApiError(extractErrorMessage(body, res.status), res.status);
	}

	const headers = res.headers;
	const streamHeader = getRequiredHeader(headers, "X-Stream-Header");
	const chunkCount = parsePositiveInt(headers.get("X-Chunk-Count"), 0);
	const hasPassword = headers.get("X-Has-Password") === "true";
	const fileCount = parsePositiveInt(headers.get("X-File-Count"), 0);
	const createdAt = getRequiredHeader(headers, "X-Created-At");
	const expiresAt = getRequiredHeader(headers, "X-Expires-At");
	const salt = headers.get("X-Salt") ?? undefined;

	// Read entire body then parse length-prefixed chunks
	const bodyData = await res.arrayBuffer();
	const view = new DataView(bodyData);
	const chunks: Uint8Array[] = [];
	let offset = 0;

	for (let i = 0; i < chunkCount; i++) {
		if (offset + UINT32_SIZE > bodyData.byteLength) break;
		const len = view.getUint32(offset, false); // explicit big-endian
		offset += UINT32_SIZE;
		if (len > MAX_REASONABLE_CHUNK_SIZE || offset + len > bodyData.byteLength) break;
		chunks.push(new Uint8Array(bodyData, offset, len));
		offset += len;
		onProgress?.((i + 1) / chunkCount);
	}

	return {
		streamHeader,
		chunkCount,
		hasPassword,
		fileCount,
		createdAt,
		expiresAt,
		chunks,
		...(salt ? { salt } : {}),
	};
}

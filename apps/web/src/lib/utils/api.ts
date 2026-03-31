import type {
	CreateNoteRequest,
	CreateNoteResponse,
	NoteExistsResponse,
	ReadNoteResponse,
} from "@secret/shared";

const API_BASE = "/api";

export async function createNote(request: CreateNoteRequest): Promise<CreateNoteResponse> {
	const res = await fetch(`${API_BASE}/notes`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(request),
	});
	if (!res.ok) {
		const error = await res.json().catch(() => ({ error: "Request failed" }));
		throw new Error(error.error ?? `HTTP ${String(res.status)}`);
	}
	return res.json() as Promise<CreateNoteResponse>;
}

export function createNoteWithProgress(
	formData: FormData,
	onProgress?: (loaded: number, total: number) => void,
): Promise<CreateNoteResponse> {
	return new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		xhr.open("POST", `${API_BASE}/notes/upload`);

		if (onProgress) {
			xhr.upload.addEventListener("progress", (e) => {
				if (e.lengthComputable) {
					onProgress(e.loaded, e.total);
				}
			});
		}

		xhr.addEventListener("load", () => {
			try {
				const data = JSON.parse(xhr.responseText) as Record<string, unknown>;
				if (xhr.status >= 200 && xhr.status < 300) {
					resolve(data as unknown as CreateNoteResponse);
				} else {
					reject(new Error((data.error as string) ?? `HTTP ${String(xhr.status)}`));
				}
			} catch {
				reject(new Error("Invalid response"));
			}
		});

		xhr.addEventListener("error", () => reject(new Error("Network error")));
		xhr.addEventListener("abort", () => reject(new Error("Upload cancelled")));

		xhr.send(formData);
	});
}

export async function checkNoteExists(id: string): Promise<NoteExistsResponse> {
	const res = await fetch(`${API_BASE}/notes/${id}/exists`);
	if (!res.ok) {
		return { exists: false, hasPassword: false, fileCount: 0, expiresAt: "", burnAfterRead: false };
	}
	return res.json() as Promise<NoteExistsResponse>;
}

export async function readNote(id: string): Promise<ReadNoteResponse> {
	const res = await fetch(`${API_BASE}/notes/${id}`);
	if (!res.ok) {
		const error = await res.json().catch(() => ({ error: "Request failed" }));
		throw new Error(error.error ?? `HTTP ${String(res.status)}`);
	}
	return res.json() as Promise<ReadNoteResponse>;
}

export async function readNoteWithProgress(
	id: string,
	onProgress?: (loaded: number, total: number) => void,
): Promise<ReadNoteResponse> {
	const res = await fetch(`${API_BASE}/notes/${id}`);
	if (!res.ok) {
		const error = await res.json().catch(() => ({ error: "Request failed" }));
		throw new Error(error.error ?? `HTTP ${String(res.status)}`);
	}

	if (!onProgress || !res.body) {
		return res.json() as Promise<ReadNoteResponse>;
	}

	const contentLength = res.headers.get("content-length");
	const total = contentLength ? parseInt(contentLength, 10) : 0;

	if (!total) {
		return res.json() as Promise<ReadNoteResponse>;
	}

	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let loaded = 0;

	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		loaded += value.length;
		onProgress(loaded, total);
	}

	const combined = await new Blob(chunks as BlobPart[]).arrayBuffer();
	const text = new TextDecoder().decode(combined);
	return JSON.parse(text) as ReadNoteResponse;
}

export async function deleteNote(id: string, deleteToken: string): Promise<void> {
	const res = await fetch(`${API_BASE}/notes/${id}`, {
		method: "DELETE",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ deleteToken }),
	});
	if (!res.ok) {
		const error = await res.json().catch(() => ({ error: "Request failed" }));
		throw new Error(error.error ?? `HTTP ${String(res.status)}`);
	}
}

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

export async function deleteNote(id: string): Promise<void> {
	await fetch(`${API_BASE}/notes/${id}`, { method: "DELETE" });
}

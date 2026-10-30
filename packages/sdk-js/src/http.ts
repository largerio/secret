import type { CreateNoteResponse, ReadNoteResponse } from "@largerio/secret-shared";
import { apiErrorOf, SecretApiError, SecretNetworkError } from "./errors.js";
import type { ReadProofs } from "./format1.js";
import type { NoteInfo } from "./types.js";
import { isXhrAvailable, postFormDataXhr } from "./xhr.js";

const UINT32_SIZE = 4;
const MAX_REASONABLE_CHUNK_COUNT = 10_000;

/**
 * Reading a note spends one of its reads as soon as the server answers, and on
 * a burn-after-read note destroys it. A retry after a timeout or a 5xx could
 * spend a second read, or turn the real error into a 404: these requests are
 * never retried, whatever `maxRetries` says.
 */
const CONSUMING_READ = false;

/**
 * Read a response body, reporting a connection lost mid-download as the
 * transport failure it is rather than a raw TypeError, and a call cancelled
 * by its signal as the signal's reason.
 */
async function readBody<T>(read: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	try {
		return await read();
	} catch (err) {
		signal?.throwIfAborted();
		throw new SecretNetworkError("Connection lost while downloading the note", { cause: err });
	}
}

async function apiError(res: Response): Promise<SecretApiError> {
	const body: unknown = await res.json().catch(() => undefined);
	return apiErrorOf(body, res.status, res.headers.get("retry-after"));
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
	readonly timeoutMs?: number;
	readonly maxRetries?: number;
	readonly retryBackoffMs?: (attempt: number) => number;
	/** The call's: aborting it rejects the call with its reason. */
	readonly signal?: AbortSignal;
	/**
	 * Whether a multipart upload with progress may go through XMLHttpRequest,
	 * which reports it, rather than `fetch`. False when the caller gave its own
	 * `fetch`: XMLHttpRequest would go around it.
	 */
	readonly xhrUploads?: boolean;
}

const defaultBackoffMs = (attempt: number): number => 2 ** attempt * 250;

/** Waits `ms` before a retry, or rejects with the signal's reason once it aborts. */
const delay = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
	new Promise((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});

/**
 * Wrap `config.fetch` with a per-request timeout and, for idempotent requests
 * only, retry on transient failures (network errors, request timeouts, and 5xx
 * responses). Non-idempotent requests (note creation/deletion) are sent exactly
 * once so a slow-but-successful write is never duplicated. On the final attempt
 * the Response is returned as-is so callers' existing body-based error handling
 * still applies.
 */
async function requestWithPolicy(
	config: HttpClientConfig,
	url: string,
	init: RequestInit,
	idempotent: boolean,
): Promise<Response> {
	// `maxRetries` is a retry count, not a total attempt count: N retries = N+1
	// attempts. Default 0 (no retry). Non-idempotent requests run exactly once.
	const maxAttempts = idempotent ? 1 + Math.max(0, config.maxRetries ?? 0) : 1;
	const backoff = config.retryBackoffMs ?? defaultBackoffMs;

	const { signal } = config;
	let lastError: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		signal?.throwIfAborted();
		const controller = config.timeoutMs === undefined ? undefined : new AbortController();
		let timedOut = false;
		const timer =
			controller === undefined
				? undefined
				: setTimeout(() => {
						timedOut = true;
						controller.abort();
					}, config.timeoutMs);
		// The caller's signal aborts the request, its body included, even once
		// the timeout no longer runs: the listener stays for the body's sake.
		signal?.addEventListener("abort", () => controller?.abort(signal.reason), { once: true });
		const requestSignal = controller?.signal ?? signal;
		try {
			const res = await config.fetch(url, {
				...init,
				...(requestSignal ? { signal: requestSignal } : {}),
			});
			if (res.status >= 500 && attempt < maxAttempts) {
				await delay(backoff(attempt), signal);
				continue;
			}
			return res;
		} catch (err) {
			signal?.throwIfAborted();
			// Surface our own timeouts as a typed SecretApiError so callers can
			// rely on the same error contract as every other failure path (a raw
			// AbortError DOMException would slip past `instanceof SecretApiError`).
			// A failed fetch (DNS, offline, connection reset, CORS) used to escape as
			// a raw TypeError, so `instanceof SecretApiError` missed it and callers
			// had no typed way to tell a transport failure from a rejection.
			lastError = timedOut
				? new SecretApiError("Request timed out", 0)
				: new SecretNetworkError("Network request failed", { cause: err });
			if (attempt >= maxAttempts) throw lastError;
			await delay(backoff(attempt), signal);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}
	/* v8 ignore next — loop always returns or throws before falling through */
	throw lastError;
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
		throw await apiError(res);
	}

	return res.json() as Promise<T>;
}

export async function postJson(
	config: HttpClientConfig,
	path: string,
	body: unknown,
	capToken?: string,
): Promise<CreateNoteResponse> {
	const res = await requestWithPolicy(
		config,
		`${config.baseUrl}${path}`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json", ...authHeaders(config.apiKey, capToken) },
			body: JSON.stringify(body),
		},
		false,
	);

	return handleResponse<CreateNoteResponse>(res);
}

export async function postFormData(
	config: HttpClientConfig,
	path: string,
	formData: FormData,
	onProgress?: (progress: number) => void,
	capToken?: string,
): Promise<CreateNoteResponse> {
	if (onProgress && config.xhrUploads !== false && isXhrAvailable()) {
		return postFormDataXhr(
			`${config.baseUrl}${path}`,
			authHeaders(config.apiKey, capToken),
			formData,
			onProgress,
			config.timeoutMs,
			config.signal,
		);
	}

	const res = await requestWithPolicy(
		config,
		`${config.baseUrl}${path}`,
		{ method: "POST", headers: authHeaders(config.apiKey, capToken), body: formData },
		false,
	);

	return handleResponse<CreateNoteResponse>(res);
}

export async function getJson<T>(
	config: HttpClientConfig,
	path: string,
	onProgress?: (progress: number) => void,
	idempotent = true,
): Promise<T> {
	const res = await requestWithPolicy(
		config,
		`${config.baseUrl}${path}`,
		{ headers: authHeaders(config.apiKey) },
		idempotent,
	);

	if (!res.ok) {
		throw await apiError(res);
	}

	const body = await download(res, config.signal, onProgress);
	return JSON.parse(new TextDecoder().decode(body)) as T;
}

/** What the headers of a read say about the note, besides how to open it. */
interface NoteReadMeta {
	readonly hasPassword: boolean;
	readonly fileCount: number;
	readonly createdAt: string;
	readonly expiresAt: string;
	readonly salt?: string;
}

function noteReadMeta(headers: Headers): NoteReadMeta {
	const salt = headers.get("X-Salt") ?? undefined;
	return {
		hasPassword: headers.get("X-Has-Password") === "true",
		fileCount: parsePositiveInt(headers.get("X-File-Count"), 0),
		createdAt: getRequiredHeader(headers, "X-Created-At"),
		expiresAt: getRequiredHeader(headers, "X-Expires-At"),
		...(salt ? { salt } : {}),
	};
}

/**
 * The whole response body, its progress reported against Content-Length when
 * the server sent one: without it, the progress is unknown until the end.
 */
async function download(
	res: Response,
	signal: AbortSignal | undefined,
	onProgress?: (progress: number) => void,
): Promise<ArrayBuffer> {
	return readBody(async () => {
		const body = res.body;
		const total = parsePositiveInt(res.headers.get("Content-Length"), 0);
		if (!onProgress || !body || total === 0) return res.arrayBuffer();

		const reader = body.getReader();
		const chunks: Uint8Array[] = [];
		let loaded = 0;

		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			loaded += value.length;
			onProgress(loaded / total);
		}

		return new Blob(chunks as BlobPart[]).arrayBuffer();
	}, signal);
}

/** A single-shot note's ciphertext: the whole body. */
async function readCiphertext(
	res: Response,
	signal: AbortSignal | undefined,
	onProgress?: (progress: number) => void,
): Promise<Uint8Array> {
	return new Uint8Array(await download(res, signal, onProgress));
}

/** Bytes received and not read yet, taken off the front in the lengths asked for. */
class ByteQueue {
	private readonly pieces: Uint8Array[] = [];
	length = 0;

	push(piece: Uint8Array): void {
		this.pieces.push(piece);
		this.length += piece.length;
	}

	/** The next `length` bytes, copied out: that many must be queued. */
	take(length: number): Uint8Array {
		const taken = new Uint8Array(length);
		let filled = 0;
		while (filled < length) {
			const piece = this.pieces[0] as Uint8Array;
			const size = Math.min(piece.length, length - filled);
			taken.set(piece.subarray(0, size), filled);
			filled += size;
			if (size === piece.length) {
				this.pieces.shift();
			} else {
				this.pieces[0] = piece.subarray(size);
			}
		}
		this.length -= length;
		return taken;
	}
}

/**
 * A note's messages as they arrive: X-Chunk-Count of them, each preceded by
 * its length, read off the body a message at a time. The body bounds each
 * one: a message may be as long as the length prefix allows. Its progress is
 * reported against Content-Length when the server sent one (a note sent
 * whole), message by message otherwise (a note sent in a session). Once its
 * reader stops, the download stops too.
 */
function framedMessages(
	res: Response,
	signal: AbortSignal | undefined,
	onProgress?: (progress: number) => void,
): AsyncGenerator<Uint8Array> {
	const count = parsePositiveInt(res.headers.get("X-Chunk-Count"), 0);
	if (count > MAX_REASONABLE_CHUNK_COUNT) {
		throw new SecretApiError(`Chunk count ${String(count)} exceeds maximum`, 502);
	}
	const total = parsePositiveInt(res.headers.get("Content-Length"), 0);
	return messagesOf(res.body?.getReader(), count, total, signal, onProgress);
}

async function* messagesOf(
	reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
	count: number,
	total: number,
	signal: AbortSignal | undefined,
	onProgress?: (progress: number) => void,
): AsyncGenerator<Uint8Array> {
	const queue = new ByteQueue();
	let loaded = 0;
	/** Whether `length` bytes are queued, once read or the body ended short of them. */
	const fill = async (length: number): Promise<boolean> => {
		while (queue.length < length) {
			const chunk = reader ? await readBody(() => reader.read(), signal) : undefined;
			if (chunk === undefined || chunk.done) {
				return false;
			}
			queue.push(chunk.value);
			loaded += chunk.value.length;
			if (total > 0) onProgress?.(loaded / total);
		}
		return true;
	};
	let received = 0;
	try {
		while (received < count && (await fill(UINT32_SIZE))) {
			const length = new DataView(queue.take(UINT32_SIZE).buffer).getUint32(0); // big-endian
			if (!(await fill(length))) break;
			yield queue.take(length);
			received++;
			if (total === 0) onProgress?.(received / count);
		}
	} finally {
		await reader?.cancel().catch(() => undefined);
	}
	if (received !== count) {
		throw new SecretApiError(
			`Expected ${String(count)} chunks but received ${String(received)}`,
			502,
		);
	}
}

/** A note's messages, all of them. */
async function readChunks(
	res: Response,
	signal: AbortSignal | undefined,
	onProgress?: (progress: number) => void,
): Promise<Uint8Array[]> {
	const chunks: Uint8Array[] = [];
	for await (const message of framedMessages(res, signal, onProgress)) {
		chunks.push(message);
	}
	return chunks;
}

async function throwUnlessOk(res: Response): Promise<void> {
	if (!res.ok) {
		throw await apiError(res);
	}
}

export interface RawNoteResponse extends NoteReadMeta {
	readonly encryptedBytes: Uint8Array;
	readonly nonceBytes: Uint8Array;
}

/** Reads a single-shot format 0 note: the server serves no other on this endpoint. */
export async function getNoteRaw(
	config: HttpClientConfig,
	id: string,
	onProgress?: (progress: number) => void,
): Promise<RawNoteResponse> {
	const res = await requestWithPolicy(
		config,
		`${config.baseUrl}/notes/${id}/raw`,
		{ headers: authHeaders(config.apiKey) },
		CONSUMING_READ,
	);
	await throwUnlessOk(res);

	const nonceBytes = safeAtob(getRequiredHeader(res.headers, "X-Client-Nonce"));
	const meta = noteReadMeta(res.headers);
	return {
		...meta,
		nonceBytes,
		encryptedBytes: await readCiphertext(res, config.signal, onProgress),
	};
}

export async function getNote(
	config: HttpClientConfig,
	id: string,
	onProgress?: (progress: number) => void,
): Promise<ReadNoteResponse> {
	return getJson<ReadNoteResponse>(config, `/notes/${id}`, onProgress, CONSUMING_READ);
}

export async function checkNote(config: HttpClientConfig, id: string): Promise<NoteInfo> {
	const res = await requestWithPolicy(
		config,
		`${config.baseUrl}/notes/${id}/exists`,
		{ headers: authHeaders(config.apiKey) },
		true,
	);

	if (!res.ok) {
		throw await apiError(res);
	}

	// The API answers 200 `{exists:false}` for a missing note — never 404 — so
	// the old 404 branch here was dead code. Worse, the success path cast the
	// body straight to NoteInfo: for a missing note the caller received every
	// required field as `undefined`, and the type said otherwise.
	const body: unknown = await res.json();
	if (!isNoteInfo(body)) {
		throw new SecretApiError("Malformed response from /exists", res.status);
	}
	return body;
}

function isNoteInfo(value: unknown): value is NoteInfo {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	if (v["exists"] === false) return true;
	return (
		v["exists"] === true &&
		typeof v["hasPassword"] === "boolean" &&
		typeof v["fileCount"] === "number" &&
		typeof v["expiresAt"] === "string" &&
		typeof v["maxReads"] === "number" &&
		// Optional: an instance running an older API does not send it.
		(v["readCount"] === undefined || isNonNegativeInteger(v["readCount"])) &&
		typeof v["chunked"] === "boolean" &&
		// A format 1 note's only.
		(v["envelope"] === undefined || typeof v["envelope"] === "string") &&
		(v["passwordAttemptsLeft"] === undefined || isNonNegativeInteger(v["passwordAttemptsLeft"]))
	);
}

function isNonNegativeInteger(value: unknown): value is number {
	return Number.isInteger(value) && (value as number) >= 0;
}

export async function deleteNote(
	config: HttpClientConfig,
	id: string,
	deleteToken: string,
	capToken?: string,
): Promise<void> {
	const res = await requestWithPolicy(
		config,
		`${config.baseUrl}/notes/${id}`,
		{
			method: "DELETE",
			headers: { "X-Delete-Token": deleteToken, ...authHeaders(config.apiKey, capToken) },
		},
		false,
	);

	if (!res.ok) {
		throw await apiError(res);
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
	const res = await requestWithPolicy(
		config,
		`${config.baseUrl}/notes/upload/init`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json", ...authHeaders(config.apiKey, capToken) },
			body: JSON.stringify(metadata),
		},
		false,
	);
	return handleResponse<ChunkedUploadInitResult>(res);
}

export async function uploadChunk(
	config: HttpClientConfig,
	uploadId: string,
	index: number,
	data: Uint8Array,
	hash: string,
): Promise<void> {
	const res = await requestWithPolicy(
		config,
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
		true,
	);
	if (!res.ok) {
		throw await apiError(res);
	}
}

export async function completeChunkedUpload(
	config: HttpClientConfig,
	uploadId: string,
	capToken?: string,
): Promise<CreateNoteResponse> {
	const res = await requestWithPolicy(
		config,
		`${config.baseUrl}/notes/upload/${uploadId}/complete`,
		{ method: "POST", headers: authHeaders(config.apiKey, capToken) },
		false,
	);
	return handleResponse<CreateNoteResponse>(res);
}

// --- Chunked download HTTP function ---

export interface StreamNoteResponse extends NoteReadMeta {
	readonly streamHeader: string;
	readonly chunkCount: number;
	readonly chunks: Uint8Array[];
}

/** Reads a chunked format 0 note: the server serves no other on this endpoint. */
export async function getNoteStream(
	config: HttpClientConfig,
	id: string,
	onProgress?: (progress: number) => void,
): Promise<StreamNoteResponse> {
	const res = await requestWithPolicy(
		config,
		`${config.baseUrl}/notes/${id}/stream`,
		{ headers: authHeaders(config.apiKey) },
		CONSUMING_READ,
	);
	await throwUnlessOk(res);

	const streamHeader = getRequiredHeader(res.headers, "X-Stream-Header");
	const meta = noteReadMeta(res.headers);
	const chunks = await readChunks(res, config.signal, onProgress);
	return { ...meta, streamHeader, chunkCount: chunks.length, chunks };
}

// --- Format 1 read ---

export interface NoteReadResponse extends NoteReadMeta {
	readonly chunks: Uint8Array[];
}

/**
 * Reads a format 1 note with the proofs its link and password derive: the
 * server answers its messages, length-prefixed, however it went up. A wrong
 * proof answers 403 and spends no read; a wrong password counts one of the
 * note's attempts.
 */
export async function postNoteRead(
	config: HttpClientConfig,
	id: string,
	proofs: ReadProofs,
	onProgress?: (progress: number) => void,
): Promise<NoteReadResponse> {
	const res = await requestNoteRead(config, id, proofs);
	const meta = noteReadMeta(res.headers);
	return { ...meta, chunks: await readChunks(res, config.signal, onProgress) };
}

export interface NoteReadStream extends NoteReadMeta {
	/** The note's messages as they arrive: pulled once, the download stopping with them. */
	readonly messages: AsyncGenerator<Uint8Array>;
}

/** Reads a format 1 note as {@link postNoteRead} does, its messages handed out as they arrive. */
export async function postNoteReadStream(
	config: HttpClientConfig,
	id: string,
	proofs: ReadProofs,
	onProgress?: (progress: number) => void,
): Promise<NoteReadStream> {
	const res = await requestNoteRead(config, id, proofs);
	const meta = noteReadMeta(res.headers);
	return { ...meta, messages: framedMessages(res, config.signal, onProgress) };
}

async function requestNoteRead(
	config: HttpClientConfig,
	id: string,
	proofs: ReadProofs,
): Promise<Response> {
	const res = await requestWithPolicy(
		config,
		`${config.baseUrl}/notes/${id}/reads`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json", ...authHeaders(config.apiKey) },
			body: JSON.stringify(proofs),
		},
		CONSUMING_READ,
	);
	await throwUnlessOk(res);
	return res;
}

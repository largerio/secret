import {
	DEFAULT_CHUNK_SIZE,
	DEFAULT_EXPIRY_SECONDS,
	MAX_FILES_PER_NOTE,
	MAX_TEXT_SIZE,
} from "@largerio/secret-shared";
import {
	decryptNote,
	decryptNoteBytes,
	decryptNoteChunked,
	encryptNote,
	encryptNoteChunked,
	ensureInit,
} from "./crypto.js";
import { SecretApiError, SecretDecryptionError, SecretValidationError } from "./errors.js";
import type { HttpClientConfig } from "./http.js";
import * as http from "./http.js";
import type {
	CreateNoteOptions,
	CreateNoteResult,
	NoteInfo,
	NotePayload,
	ReadNoteOptions,
	ReadNoteResult,
	SecretClientConfig,
} from "./types.js";

// Overall-progress milestones (0–1) reported through onProgress. Each upload or
// read path splits its progress bar between phases; these named boundaries
// replace the magic decimals that were previously scattered inline.
const PROGRESS = {
	// Standard upload: encryption fills the bar up to here, upload fills the rest.
	standardEncrypted: 0.3,
	// Chunked upload: encryption up to here, then chunk upload spans the rest.
	chunkedEncrypted: 0.2,
	chunkedUploadSpan: 0.7,
	// Read: download spans this fraction, decryption fills the remainder.
	downloadSpan: 0.7,
} as const;

async function sha256hex(data: Uint8Array): Promise<string> {
	const hashBuffer = await crypto.subtle.digest(
		"SHA-256",
		data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
	);
	return Array.from(new Uint8Array(hashBuffer))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export class SecretClient {
	private readonly httpConfig: HttpClientConfig;

	private constructor(config: SecretClientConfig) {
		const baseUrl = config.baseUrl ?? "";
		this.httpConfig = {
			baseUrl: `${baseUrl}/api/v1`,
			fetch: config.fetch ?? globalThis.fetch.bind(globalThis),
			...(config.apiKey ? { apiKey: config.apiKey } : {}),
			...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
			...(config.maxRetries !== undefined ? { maxRetries: config.maxRetries } : {}),
			...(config.retryBackoffMs ? { retryBackoffMs: config.retryBackoffMs } : {}),
		};
	}

	/**
	 * Create a client, waiting for the libsodium WASM module to initialise.
	 *
	 * Always use this rather than `new SecretClient()`: the constructor cannot
	 * await, and every crypto call would throw until initialisation completed.
	 *
	 * @example
	 * ```ts
	 * const client = await SecretClient.create({ baseUrl: "https://secret.example.com" });
	 * ```
	 */
	static async create(config?: SecretClientConfig): Promise<SecretClient> {
		await ensureInit();
		return new SecretClient(config ?? {});
	}

	/**
	 * Encrypt a note in this process and upload the ciphertext.
	 *
	 * The returned `keyFragment` is **never sent to the server** and cannot be
	 * recovered from it: lose it and the note is unreadable. Large payloads
	 * switch to a chunked upload automatically.
	 *
	 * Writes require authentication unless the instance is open: pass `apiKey`
	 * to the client, or a `capToken` obtained from a Proof-of-Work challenge.
	 *
	 * @returns The note id, the key fragment, and the delete token that allows
	 * revoking the note later.
	 * @throws {SecretValidationError} if the payload exceeds a protocol limit
	 * (checked before any encryption or upload work).
	 * @throws {SecretApiError} if the server rejects the request (401 unauthorized,
	 * 413 too large, 429 rate-limited).
	 * @throws {SecretNetworkError} if the request never reached the server.
	 *
	 * @example
	 * ```ts
	 * const { id, keyFragment } = await client.createNote({ text: "hello", maxReads: 1 });
	 * const url = client.buildShareUrl(id, keyFragment);
	 * ```
	 */
	async createNote(options: CreateNoteOptions): Promise<CreateNoteResult> {
		const fileCount = options.files?.length ?? 0;
		const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;

		// Fail fast on protocol-level limits (not instance-configurable) so the
		// caller gets an error before encrypting and uploading the whole payload.
		if (options.text !== undefined && options.text.length > MAX_TEXT_SIZE) {
			throw new SecretValidationError(
				`Text exceeds the maximum length of ${String(MAX_TEXT_SIZE)} characters`,
			);
		}
		if (fileCount > MAX_FILES_PER_NOTE) {
			throw new SecretValidationError(
				`A note can include at most ${String(MAX_FILES_PER_NOTE)} files`,
			);
		}

		const payload: NotePayload = {
			...(options.text !== undefined ? { text: options.text } : {}),
			...(options.contentMode ? { contentMode: options.contentMode } : {}),
			...(options.files && options.files.length > 0
				? {
						files: options.files.map((f) => ({
							name: f.name,
							type: f.type,
							size: f.data.length,
							data: f.data,
						})),
					}
				: {}),
		};

		// Estimate payload size to decide between standard and chunked upload
		const estimatedSize = this.estimatePayloadSize(payload);
		const useChunked = options.chunked === true || estimatedSize > chunkSize;

		if (useChunked) {
			return this.createNoteChunked(payload, fileCount, chunkSize, options);
		}

		options.onProgress?.({ phase: "encrypting", phaseProgress: 0, overallProgress: 0 });
		const encrypted = await encryptNote(payload, options.password);
		options.onProgress?.({
			phase: "encrypting",
			phaseProgress: 1,
			overallProgress: PROGRESS.standardEncrypted,
		});

		options.onProgress?.({
			phase: "uploading",
			phaseProgress: 0,
			overallProgress: PROGRESS.standardEncrypted,
		});
		let response: { id: string; expiresAt: string; deleteToken: string };

		if (fileCount > 0) {
			const metadata = JSON.stringify({
				clientNonce: encrypted.clientNonce,
				hasPassword: !!options.password,
				expiresIn: options.expiresIn ?? DEFAULT_EXPIRY_SECONDS,
				maxReads: options.maxReads ?? 1,
				fileCount,
				...(encrypted.salt ? { salt: encrypted.salt } : {}),
			});

			const blob = new Blob([encrypted.encryptedBytes] as BlobPart[]);

			const formData = new FormData();
			formData.append("metadata", metadata);
			formData.append("data", blob);

			// Map byte-level upload progress onto the overall bar so it advances
			// smoothly across the upload phase instead of jumping at boundaries.
			const uploadSpan = 1 - PROGRESS.standardEncrypted;
			const onUpload =
				options.onUploadProgress || options.onProgress
					? (p: number): void => {
							options.onUploadProgress?.(p);
							options.onProgress?.({
								phase: "uploading",
								phaseProgress: p,
								overallProgress: PROGRESS.standardEncrypted + p * uploadSpan,
							});
						}
					: undefined;

			response = await http.postFormData(
				this.httpConfig,
				"/notes/upload",
				formData,
				onUpload,
				options.capToken,
			);
		} else {
			response = await http.postJson(
				this.httpConfig,
				"/notes",
				{
					encryptedData: encrypted.encryptedData,
					clientNonce: encrypted.clientNonce,
					hasPassword: !!options.password,
					expiresIn: options.expiresIn ?? DEFAULT_EXPIRY_SECONDS,
					maxReads: options.maxReads ?? 1,
					fileCount: 0,
					...(encrypted.salt ? { salt: encrypted.salt } : {}),
				},
				options.capToken,
			);
		}

		options.onProgress?.({ phase: "processing", phaseProgress: 1, overallProgress: 1 });

		return {
			id: response.id,
			expiresAt: response.expiresAt,
			deleteToken: response.deleteToken,
			keyFragment: encrypted.keyFragment,
		};
	}

	private async createNoteChunked(
		payload: NotePayload,
		fileCount: number,
		chunkSize: number,
		options: CreateNoteOptions,
	): Promise<CreateNoteResult> {
		options.onProgress?.({ phase: "encrypting", phaseProgress: 0, overallProgress: 0 });
		const encrypted = await encryptNoteChunked(payload, chunkSize, options.password);
		const totalChunks = encrypted.chunks.length;
		options.onProgress?.({
			phase: "encrypting",
			phaseProgress: 1,
			overallProgress: PROGRESS.chunkedEncrypted,
		});

		// Init chunked upload session
		options.onProgress?.({
			phase: "uploading",
			phaseProgress: 0,
			overallProgress: PROGRESS.chunkedEncrypted,
			currentChunk: 0,
			totalChunks,
		});

		const { uploadId } = await http.initChunkedUpload(
			this.httpConfig,
			{
				streamHeader: encrypted.header,
				clientNonce: encrypted.clientNonce,
				chunkCount: totalChunks,
				hasPassword: !!options.password,
				expiresIn: options.expiresIn ?? DEFAULT_EXPIRY_SECONDS,
				maxReads: options.maxReads ?? 1,
				fileCount,
				...(encrypted.salt ? { salt: encrypted.salt } : {}),
			},
			options.capToken,
		);

		// Upload each chunk
		for (let i = 0; i < totalChunks; i++) {
			const chunk = encrypted.chunks[i];
			/* v8 ignore next */
			if (!chunk) break;
			const hash = await sha256hex(chunk);
			await http.uploadChunk(this.httpConfig, uploadId, i, chunk, hash);

			const chunkProgress = (i + 1) / totalChunks;
			options.onUploadProgress?.(chunkProgress);
			options.onProgress?.({
				phase: "uploading",
				phaseProgress: chunkProgress,
				overallProgress: PROGRESS.chunkedEncrypted + chunkProgress * PROGRESS.chunkedUploadSpan,
				currentChunk: i + 1,
				totalChunks,
			});
		}

		// Complete chunked upload
		const response = await http.completeChunkedUpload(this.httpConfig, uploadId, options.capToken);

		options.onProgress?.({ phase: "processing", phaseProgress: 1, overallProgress: 1 });

		return {
			id: response.id,
			expiresAt: response.expiresAt,
			deleteToken: response.deleteToken,
			keyFragment: encrypted.keyFragment,
		};
	}

	private estimatePayloadSize(payload: NotePayload): number {
		let size = 0;
		if (payload.text) {
			size += payload.text.length * 2; // rough UTF-8 estimate
		}
		if (payload.files) {
			for (const file of payload.files) {
				size += file.data.length;
			}
		}
		return size;
	}

	/**
	 * Fetch a note's metadata without consuming a read.
	 *
	 * Narrow on `exists` before reading any other field. Note that an expired
	 * note is indistinguishable from one that never existed — deliberately, so
	 * the endpoint cannot be used as an existence oracle.
	 *
	 * @throws {SecretApiError} on a server error (including 429).
	 * @throws {SecretNetworkError} if the request never reached the server.
	 */
	async checkNote(id: string): Promise<NoteInfo> {
		return http.checkNote(this.httpConfig, id);
	}

	/**
	 * Download a note and decrypt it locally.
	 *
	 * **This consumes a read.** On a burn-after-read note the server destroys it
	 * the moment the ciphertext is served — before decryption is even attempted —
	 * so a wrong password still spends the only read. Check `hasPassword` with
	 * {@link checkNote} first and collect the password before calling this.
	 *
	 * @param keyFragment The key from the share URL fragment.
	 * @throws {SecretDecryptionError} for a wrong password, a wrong key, or
	 * tampered ciphertext — deliberately indistinguishable, to avoid an oracle.
	 * @throws {SecretApiError} with status 404 when the note is gone (expired,
	 * already burned, or never existed).
	 * @throws {SecretNetworkError} if the request never reached the server.
	 */
	async readNote(
		id: string,
		keyFragment: string,
		options?: ReadNoteOptions,
	): Promise<ReadNoteResult> {
		options?.onProgress?.({ phase: "downloading", phaseProgress: 0, overallProgress: 0 });

		if (options?.chunked === true) {
			return this.readNoteStream(id, keyFragment, options);
		}

		if (options?.chunked === false) {
			return this.readNoteStandard(id, keyFragment, options);
		}

		// No hint — try stream first, fall back to raw then legacy
		try {
			return await this.readNoteStream(id, keyFragment, options);
		} catch (err) {
			if (err instanceof SecretDecryptionError) {
				throw err;
			}
			if (!(err instanceof SecretApiError) || err.status !== 400) {
				throw err;
			}
		}

		return this.readNoteStandard(id, keyFragment, options);
	}

	private async readNoteStandard(
		id: string,
		keyFragment: string,
		options?: ReadNoteOptions,
	): Promise<ReadNoteResult> {
		try {
			return await this.readNoteRaw(id, keyFragment, options);
		} catch (err) {
			if (err instanceof SecretDecryptionError) {
				throw err;
			}
			if (err instanceof SecretApiError && (err.status === 400 || err.status === 404)) {
				return this.readNoteLegacy(id, keyFragment, options);
			}
			throw err;
		}
	}

	private async readNoteRaw(
		id: string,
		keyFragment: string,
		options?: ReadNoteOptions,
	): Promise<ReadNoteResult> {
		const response = await http.getNoteRaw(this.httpConfig, id, (p) => {
			options?.onDownloadProgress?.(p);
			options?.onProgress?.({
				phase: "downloading",
				phaseProgress: p,
				overallProgress: p * PROGRESS.downloadSpan,
			});
		});

		options?.onProgress?.({
			phase: "decrypting",
			phaseProgress: 0,
			overallProgress: PROGRESS.downloadSpan,
		});
		let payload: NotePayload;
		try {
			payload = await decryptNoteBytes(
				response.encryptedBytes,
				response.nonceBytes,
				keyFragment,
				options?.password,
				response.salt,
			);
		} catch {
			// Uniform error: never reveal whether the password/key was wrong or
			// the ciphertext was tampered with (avoids a decryption oracle).
			throw new SecretDecryptionError();
		}

		options?.onProgress?.({ phase: "decrypting", phaseProgress: 1, overallProgress: 1 });

		return {
			payload,
			createdAt: response.createdAt,
			expiresAt: response.expiresAt,
			fileCount: response.fileCount,
		};
	}

	private async readNoteLegacy(
		id: string,
		keyFragment: string,
		options?: ReadNoteOptions,
	): Promise<ReadNoteResult> {
		const response = await http.getNote(this.httpConfig, id, options?.onDownloadProgress);

		let payload: NotePayload;
		try {
			payload = await decryptNote(
				response.encryptedData,
				response.clientNonce,
				keyFragment,
				options?.password,
				response.salt,
			);
		} catch {
			// Uniform error: never reveal whether the password/key was wrong or
			// the ciphertext was tampered with (avoids a decryption oracle).
			throw new SecretDecryptionError();
		}

		return {
			payload,
			createdAt: response.createdAt,
			expiresAt: response.expiresAt,
			fileCount: response.fileCount,
		};
	}

	private async readNoteStream(
		id: string,
		keyFragment: string,
		options?: ReadNoteOptions,
	): Promise<ReadNoteResult> {
		const response = await http.getNoteStream(this.httpConfig, id, (p) => {
			options?.onDownloadProgress?.(p);
			options?.onProgress?.({
				phase: "downloading",
				phaseProgress: p,
				overallProgress: p * PROGRESS.downloadSpan,
			});
		});

		options?.onProgress?.({
			phase: "decrypting",
			phaseProgress: 0,
			overallProgress: PROGRESS.downloadSpan,
		});
		let payload: NotePayload;
		try {
			payload = await decryptNoteChunked(
				response.chunks,
				response.streamHeader,
				keyFragment,
				options?.password,
				response.salt,
			);
		} catch {
			// Uniform error: never reveal whether the password/key was wrong or
			// the ciphertext was tampered with (avoids a decryption oracle).
			throw new SecretDecryptionError();
		}

		options?.onProgress?.({ phase: "decrypting", phaseProgress: 1, overallProgress: 1 });

		return {
			payload,
			createdAt: response.createdAt,
			expiresAt: response.expiresAt,
			fileCount: response.fileCount,
		};
	}

	/**
	 * Revoke a note before it expires, using the delete token from
	 * {@link createNote}. Idempotent from the caller's perspective only in that a
	 * second call reports 404.
	 *
	 * @throws {SecretApiError} 403 for a wrong token, 404 if the note is already gone.
	 * @throws {SecretNetworkError} if the request never reached the server.
	 */
	async deleteNote(id: string, deleteToken: string, capToken?: string): Promise<void> {
		return http.deleteNote(this.httpConfig, id, deleteToken, capToken);
	}

	/**
	 * Build the shareable URL for a note. The key lives in the fragment, which
	 * browsers never send to the server — that is what keeps the sharing
	 * zero-knowledge.
	 *
	 * With the default relative `baseUrl` the result is relative too
	 * (`/note/<id>#<key>`); prepend an origin before sending it to anyone.
	 */
	buildShareUrl(id: string, keyFragment: string): string {
		const base = this.httpConfig.baseUrl.replace("/api/v1", "");
		return `${base}/note/${encodeURIComponent(id)}#${encodeURIComponent(keyFragment)}`;
	}

	/**
	 * Split a share URL back into its note id and key fragment. Accepts absolute
	 * and relative URLs, so it round-trips the output of {@link buildShareUrl}
	 * under the default (relative) configuration.
	 *
	 * @throws {SecretValidationError} if the URL is malformed, names no note, or
	 * carries no key fragment — the usual sign of a link truncated in transit.
	 */
	static parseShareUrl(url: string): { id: string; keyFragment: string } {
		let parsed: URL;
		try {
			// A base is supplied so a relative URL parses: `new URL()` alone threw a
			// raw TypeError on exactly what buildShareUrl produces by default.
			parsed = new URL(url, "http://share.invalid");
		} catch {
			throw new SecretValidationError("Invalid share URL");
		}

		const pathParts = parsed.pathname.split("/");
		const noteIndex = pathParts.indexOf("note");

		const id = noteIndex !== -1 ? pathParts[noteIndex + 1] : undefined;
		if (!id) {
			throw new SecretValidationError("Invalid share URL: missing note ID");
		}

		const keyFragment = decodeURIComponent(parsed.hash.slice(1));
		if (!keyFragment) {
			throw new SecretValidationError("Invalid share URL: missing key fragment");
		}

		return { id: decodeURIComponent(id), keyFragment };
	}
}

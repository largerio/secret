import type { NotePayload } from "@largerio/secret-shared";
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

	static async create(config?: SecretClientConfig): Promise<SecretClient> {
		await ensureInit();
		return new SecretClient(config ?? {});
	}

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

	async checkNote(id: string): Promise<NoteInfo> {
		return http.checkNote(this.httpConfig, id);
	}

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

	async deleteNote(id: string, deleteToken: string, capToken?: string): Promise<void> {
		return http.deleteNote(this.httpConfig, id, deleteToken, capToken);
	}

	buildShareUrl(id: string, keyFragment: string): string {
		const base = this.httpConfig.baseUrl.replace("/api/v1", "");
		return `${base}/note/${encodeURIComponent(id)}#${encodeURIComponent(keyFragment)}`;
	}

	static parseShareUrl(url: string): { id: string; keyFragment: string } {
		const parsed = new URL(url);
		const pathParts = parsed.pathname.split("/");
		const noteIndex = pathParts.indexOf("note");

		const id = noteIndex !== -1 ? pathParts[noteIndex + 1] : undefined;
		if (!id) {
			throw new Error("Invalid share URL: missing note ID");
		}
		const keyFragment = parsed.hash.slice(1);

		if (!keyFragment) {
			throw new Error("Invalid share URL: missing key fragment");
		}

		return { id, keyFragment };
	}
}

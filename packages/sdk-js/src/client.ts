import type { NotePayload } from "@secret/shared";
import { DEFAULT_CHUNK_SIZE, DEFAULT_EXPIRY_SECONDS } from "@secret/shared";
import {
	decryptNote,
	decryptNoteBytes,
	decryptNoteChunked,
	encryptNote,
	encryptNoteChunked,
	ensureInit,
} from "./crypto.js";
import { SecretApiError, SecretDecryptionError } from "./errors.js";
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
		};
	}

	static async create(config?: SecretClientConfig): Promise<SecretClient> {
		await ensureInit();
		return new SecretClient(config ?? {});
	}

	async createNote(options: CreateNoteOptions): Promise<CreateNoteResult> {
		const fileCount = options.files?.length ?? 0;
		const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;

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
		options.onProgress?.({ phase: "encrypting", phaseProgress: 1, overallProgress: 0.3 });

		options.onProgress?.({ phase: "uploading", phaseProgress: 0, overallProgress: 0.3 });
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

			response = await http.postFormData(
				this.httpConfig,
				"/notes/upload",
				formData,
				options.onUploadProgress,
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
		options.onProgress?.({ phase: "encrypting", phaseProgress: 1, overallProgress: 0.2 });

		// Init chunked upload session
		options.onProgress?.({
			phase: "uploading",
			phaseProgress: 0,
			overallProgress: 0.2,
			currentChunk: 0,
			totalChunks,
		});

		const { uploadId } = await http.initChunkedUpload(
			this.httpConfig,
			{
				streamHeader: encrypted.header,
				clientNonce: encrypted.header, // reuse header as nonce for metadata consistency
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
				overallProgress: 0.2 + chunkProgress * 0.7,
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
			options?.onProgress?.({ phase: "downloading", phaseProgress: p, overallProgress: p * 0.7 });
		});

		options?.onProgress?.({ phase: "decrypting", phaseProgress: 0, overallProgress: 0.7 });
		let payload: NotePayload;
		try {
			payload = await decryptNoteBytes(
				response.encryptedBytes,
				response.nonceBytes,
				keyFragment,
				options?.password,
				response.salt,
			);
		} catch (err) {
			throw new SecretDecryptionError(err instanceof Error ? err.message : "Decryption failed");
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
		} catch (err) {
			throw new SecretDecryptionError(err instanceof Error ? err.message : "Decryption failed");
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
				overallProgress: p * 0.7,
			});
		});

		options?.onProgress?.({ phase: "decrypting", phaseProgress: 0, overallProgress: 0.7 });
		let payload: NotePayload;
		try {
			payload = await decryptNoteChunked(
				response.chunks,
				response.streamHeader,
				keyFragment,
				options?.password,
				response.salt,
			);
		} catch (err) {
			throw new SecretDecryptionError(err instanceof Error ? err.message : "Decryption failed");
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

import type { NotePayload } from "@secret/shared";
import { DEFAULT_EXPIRY_SECONDS } from "@secret/shared";
import { decryptNote, encryptNote, ensureInit } from "./crypto.js";
import { SecretDecryptionError } from "./errors.js";
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

		const encrypted = await encryptNote(payload, options.password);

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

			const blob = new Blob([
				Uint8Array.from(atob(encrypted.encryptedData), (c) => c.charCodeAt(0)),
			]);

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

		return {
			id: response.id,
			expiresAt: response.expiresAt,
			deleteToken: response.deleteToken,
			keyFragment: encrypted.keyFragment,
		};
	}

	async checkNote(id: string): Promise<NoteInfo> {
		return http.checkNote(this.httpConfig, id);
	}

	async readNote(
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

	async deleteNote(id: string, deleteToken: string, capToken?: string): Promise<void> {
		return http.deleteNote(this.httpConfig, id, deleteToken, capToken);
	}

	buildShareUrl(id: string, keyFragment: string): string {
		const base = this.httpConfig.baseUrl.replace("/api/v1", "");
		return `${base}/note/${id}#${keyFragment}`;
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

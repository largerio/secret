import {
	DEFAULT_CHUNK_SIZE,
	DEFAULT_EXPIRY_SECONDS,
	MAX_FILES_PER_NOTE,
	MAX_TEXT_SIZE,
	withoutTrailingSlashes,
} from "@largerio/secret-shared";
import {
	decryptNote,
	decryptNoteBytes,
	decryptNoteChunked,
	encryptNote,
	encryptNoteChunked,
	ensureInit,
	sha256Hex,
	toBase64,
} from "./crypto.js";
import { SecretApiError, SecretDecryptionError, SecretValidationError } from "./errors.js";
import {
	assertFormat1Fragment,
	closeFormat1Read,
	encryptNoteFormat1,
	type Format1Body,
	type Format1Head,
	type Format1Read,
	type Format1Settings,
	format1BodyOf,
	formatOfFragment,
	type NoteSource,
	OutsideFailure,
	openNoteFormat1,
	prepareFormat1Read,
	sealNoteFormat1,
	streamNoteFormat1,
} from "./format1.js";
import type { HttpClientConfig } from "./http.js";
import * as http from "./http.js";
import type {
	CreateNoteOptions,
	CreateNoteResult,
	NoteFile,
	NoteInfo,
	NotePayload,
	ReadNoteIntoOptions,
	ReadNoteIntoResult,
	ReadNoteOptions,
	ReadNoteResult,
	RequestOptions,
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

/**
 * The error a failed decryption surfaces as.
 *
 * Wrong password, wrong key and tampered ciphertext all become the same
 * SecretDecryptionError: telling them apart would make reads a password
 * oracle. A SecretValidationError (the server sent no salt for a password
 * note, typically a proxy stripping X-Salt) is not a decryption failure and
 * keeps its own type, so the caller can report what actually went wrong.
 */
/** The codes of a refused proof (PROTOCOL.md, "Proof of reading"). */
const REFUSED_PROOFS: ReadonlySet<string> = new Set(["wrong_link_proof", "wrong_password"]);
/** What instances up to 1.6, which name no code, answer a refused proof. */
const REFUSED_PROOFS_BEFORE_CODES: ReadonlySet<string> = new Set([
	"Invalid link proof",
	"Wrong password",
]);

/**
 * Whether a read's refusal is the instance's of a proof. A `403` the instance
 * did not answer, a proxy's or a firewall's, is not: reporting it as a wrong
 * password would have the reader spend attempts on a password that was right.
 */
function isRefusedProof(err: SecretApiError): boolean {
	if (err.status !== 403) {
		return false;
	}
	return err.code === undefined
		? REFUSED_PROOFS_BEFORE_CODES.has(err.message)
		: REFUSED_PROOFS.has(err.code);
}

function uniformDecryptionError(err: unknown): Error {
	if (err instanceof SecretValidationError) return err;
	return new SecretDecryptionError();
}

/**
 * Sends a read's proofs. A wrong link or a wrong password, which the server
 * tells by its proofs, is the same error as a key that fails to decrypt.
 */
async function sendingProofs<T>(send: () => Promise<T>): Promise<T> {
	try {
		return await send();
	} catch (err) {
		if (err instanceof SecretApiError && isRefusedProof(err)) {
			throw new SecretDecryptionError();
		}
		throw err;
	}
}

/** The settings a note declares besides its ciphertext, defaults applied. */
function noteSettings(options: CreateNoteOptions, fileCount: number): Format1Settings {
	return {
		fileCount,
		maxReads: options.maxReads ?? 1,
		expiresIn: options.expiresIn ?? DEFAULT_EXPIRY_SECONDS,
	};
}

/**
 * A note about to be encrypted: format 1's body, laid out, or format 0's
 * payload, its files read into memory.
 */
type Writing = { readonly body: Format1Body } | { readonly payload: NotePayload };

/** The note a writer gives, as the options hold it. */
function sourceOf(options: CreateNoteOptions): NoteSource {
	return {
		...(options.text !== undefined ? { text: options.text } : {}),
		...(options.contentMode ? { contentMode: options.contentMode } : {}),
		...(options.files && options.files.length > 0 ? { files: options.files } : {}),
	};
}

/** A format 0 note's payload: format 0 is encrypted in memory, a Blob read whole first. */
async function payloadOf(source: NoteSource): Promise<NotePayload> {
	const files: NoteFile[] = [];
	for (const file of source.files ?? []) {
		const data =
			file.data instanceof Uint8Array ? file.data : new Uint8Array(await file.data.arrayBuffer());
		files.push({ name: file.name, type: file.type, size: data.length, data });
	}
	return {
		...(source.text !== undefined ? { text: source.text } : {}),
		...(source.contentMode ? { contentMode: source.contentMode } : {}),
		...(files.length > 0 ? { files } : {}),
	};
}

/**
 * Writes a note's files, read whole already, to the caller's streams, each
 * closed once written.
 */
async function writeFiles(
	files: ReadonlyArray<NoteFile>,
	openFile: ReadNoteIntoOptions["openFile"],
): Promise<void> {
	for (const [index, { name, type, size, data }] of files.entries()) {
		const writer = (await openFile({ name, type, size }, index)).getWriter();
		try {
			await writer.write(data);
			await writer.close();
		} catch (err) {
			await writer.abort(err).catch(() => undefined);
			throw err;
		}
	}
}

/** A single-shot note, encrypted, and the fields its format sends beside the ciphertext. */
interface SealedNote {
	readonly encryptedBytes: Uint8Array;
	readonly encryptedData: string;
	readonly keyFragment: string;
	readonly fields: Record<string, unknown>;
}

/**
 * Seals a note sent in one request. A format 1 note's body, laid out already,
 * goes as one message.
 */
async function sealNote(
	writing: Writing,
	fileCount: number,
	options: CreateNoteOptions,
): Promise<SealedNote> {
	const settings = noteSettings(options, fileCount);
	if ("body" in writing) {
		const { body } = writing;
		const sealed = await encryptNoteFormat1(body, body.length, settings, options.password);
		const [message] = sealed.messages as [Uint8Array];
		return {
			encryptedBytes: message,
			encryptedData: toBase64(message),
			keyFragment: sealed.keyFragment,
			fields: { envelope: sealed.envelope, ...sealed.verifiers },
		};
	}
	const sealed = await encryptNote(writing.payload, options.password);
	return {
		...sealed,
		fields: {
			clientNonce: sealed.clientNonce,
			hasPassword: !!options.password,
			...settings,
			...(sealed.salt ? { salt: sealed.salt } : {}),
		},
	};
}

/** decodeURIComponent, with a malformed escape reported as an invalid share URL. */
function decodeUrlPart(part: string): string {
	try {
		return decodeURIComponent(part);
	} catch {
		throw new SecretValidationError("Invalid share URL");
	}
}

export class SecretClient {
	private readonly httpConfig: HttpClientConfig;

	private constructor(config: SecretClientConfig) {
		// A trailing slash ("https://secret.example.com/") built "//api/v1" URLs.
		const baseUrl = withoutTrailingSlashes(config.baseUrl ?? "");
		this.httpConfig = {
			baseUrl: `${baseUrl}/api/v1`,
			fetch: config.fetch ?? globalThis.fetch.bind(globalThis),
			...(config.apiKey ? { apiKey: config.apiKey } : {}),
			...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
			...(config.maxRetries !== undefined ? { maxRetries: config.maxRetries } : {}),
			...(config.retryBackoffMs ? { retryBackoffMs: config.retryBackoffMs } : {}),
			xhrUploads: config.fetch === undefined,
		};
	}

	/** The HTTP configuration of one call: the client's, with the call's signal. */
	private configFor(options?: RequestOptions): http.HttpClientConfig {
		return options?.signal ? { ...this.httpConfig, signal: options.signal } : this.httpConfig;
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
	 * The note is written in format 1 (PROTOCOL.md) unless `format: 0` is
	 * passed. An instance older than 1.6.0 refuses format 1 with a 400, and an
	 * SDK older than 1.3.0 cannot read it.
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
		// Checked, not assumed: from JavaScript, "1" or 2 would write format 0
		// without a word.
		if (options.format !== undefined && options.format !== 0 && options.format !== 1) {
			throw new SecretValidationError("Unsupported note format");
		}

		const source = sourceOf(options);
		const writing: Writing =
			options.format === 0 ? { payload: await payloadOf(source) } : { body: format1BodyOf(source) };

		// The payload's size decides between one request and an upload session:
		// a format 1 note's padded body, laid out first, or format 0's estimate.
		// A note without files goes in one request, which takes any text
		// MAX_TEXT_SIZE allows: format 0 would put all of it in its first chunk,
		// which an instance refuses beyond its chunk size, and the instance keeps
		// a note sent whole in its database.
		const size =
			"body" in writing ? writing.body.length : this.estimatePayloadSize(writing.payload);
		const useChunked = options.chunked === true || (fileCount > 0 && size > chunkSize);

		if (useChunked) {
			return this.createNoteChunked(writing, fileCount, chunkSize, options);
		}

		options.signal?.throwIfAborted();
		options.onProgress?.({ phase: "encrypting", phaseProgress: 0, overallProgress: 0 });
		const sealed = await sealNote(writing, fileCount, options);
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
			const metadata = JSON.stringify(sealed.fields);

			const blob = new Blob([sealed.encryptedBytes] as BlobPart[]);

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
				this.configFor(options),
				"/notes/upload",
				formData,
				onUpload,
				options.capToken,
			);
		} else {
			response = await http.postJson(
				this.configFor(options),
				"/notes",
				{ encryptedData: sealed.encryptedData, ...sealed.fields },
				options.capToken,
			);
		}

		options.onProgress?.({ phase: "processing", phaseProgress: 1, overallProgress: 1 });

		return {
			id: response.id,
			expiresAt: response.expiresAt,
			deleteToken: response.deleteToken,
			keyFragment: sealed.keyFragment,
		};
	}

	/**
	 * Sends a note in an upload session. A format 1 note's keys are derived and
	 * the session opened before its body is encrypted, a message at a time as
	 * each goes up: a refused session costs no encryption, and only the message
	 * going up is held. Format 0 is encrypted whole first.
	 */
	private async createNoteChunked(
		writing: Writing,
		fileCount: number,
		chunkSize: number,
		options: CreateNoteOptions,
	): Promise<CreateNoteResult> {
		options.signal?.throwIfAborted();
		options.onProgress?.({ phase: "encrypting", phaseProgress: 0, overallProgress: 0 });
		const settings = noteSettings(options, fileCount);
		if ("payload" in writing) {
			const sealed = await encryptNoteChunked(writing.payload, chunkSize, options.password);
			const fields = {
				streamHeader: sealed.header,
				clientNonce: sealed.clientNonce,
				hasPassword: !!options.password,
				...settings,
				...(sealed.salt ? { salt: sealed.salt } : {}),
			};
			return this.sendInSession(
				fields,
				sealed.chunks,
				sealed.chunks.length,
				sealed.keyFragment,
				options,
			);
		}
		const sealing = await sealNoteFormat1(writing.body, chunkSize, settings, options.password);
		try {
			const fields = { envelope: sealing.envelope, ...sealing.verifiers };
			return await this.sendInSession(
				fields,
				sealing.messages,
				sealing.messageCount,
				sealing.keyFragment,
				options,
			);
		} finally {
			sealing.close();
		}
	}

	/** Opens an upload session, sends the messages one by one as they come, and completes it. */
	private async sendInSession(
		fields: Record<string, unknown>,
		messages: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
		totalChunks: number,
		keyFragment: string,
		options: CreateNoteOptions,
	): Promise<CreateNoteResult> {
		options.onProgress?.({
			phase: "encrypting",
			phaseProgress: 1,
			overallProgress: PROGRESS.chunkedEncrypted,
		});
		options.onProgress?.({
			phase: "uploading",
			phaseProgress: 0,
			overallProgress: PROGRESS.chunkedEncrypted,
			currentChunk: 0,
			totalChunks,
		});

		const { uploadId } = await http.initChunkedUpload(
			this.configFor(options),
			{ ...fields, chunkCount: totalChunks },
			options.capToken,
		);

		let sent = 0;
		for await (const chunk of messages) {
			await http.uploadChunk(this.configFor(options), uploadId, sent, chunk, sha256Hex(chunk));
			sent++;

			const chunkProgress = sent / totalChunks;
			options.onUploadProgress?.(chunkProgress);
			options.onProgress?.({
				phase: "uploading",
				phaseProgress: chunkProgress,
				overallProgress: PROGRESS.chunkedEncrypted + chunkProgress * PROGRESS.chunkedUploadSpan,
				currentChunk: sent,
				totalChunks,
			});
		}

		const response = await http.completeChunkedUpload(
			this.configFor(options),
			uploadId,
			options.capToken,
		);

		options.onProgress?.({ phase: "processing", phaseProgress: 1, overallProgress: 1 });

		return {
			id: response.id,
			expiresAt: response.expiresAt,
			deleteToken: response.deleteToken,
			keyFragment,
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
	async checkNote(id: string, options?: RequestOptions): Promise<NoteInfo> {
		return http.checkNote(this.configFor(options), id);
	}

	/**
	 * Download a note and decrypt it locally.
	 *
	 * **This consumes a read.** A format 0 note is served to anyone who knows
	 * its id, before any check of the key: on a burn-after-read note the server
	 * destroys it the moment the ciphertext is served, so a wrong password still
	 * spends the only read. Check `hasPassword` with {@link checkNote} first and
	 * collect the password before calling this.
	 *
	 * A format 1 note is served only once the reader proves it holds the link,
	 * and the password of a password note (PROTOCOL.md): a wrong password spends
	 * no read, but the note takes five over its life, and the fifth deletes it
	 * (`passwordAttemptsLeft` in {@link checkNote}).
	 *
	 * @param keyFragment The key from the share URL fragment. It names the
	 * note's format: `1.` then the key for format 1, the bare key for format 0.
	 * @throws {SecretValidationError} for a malformed format 1 link, or a link of
	 * a format this SDK does not know: refused before anything is read.
	 * @throws {SecretDecryptionError} for a wrong password, a wrong key, or
	 * tampered ciphertext — deliberately indistinguishable, to avoid an oracle.
	 * For a format 1 note, also for a password note read without its password,
	 * an envelope this SDK refuses, or a format 1 link to a format 0 note: all
	 * refused before any read is spent.
	 * @throws {SecretApiError} with status 404 when the note is gone (expired,
	 * already burned, or never existed); with status 400 for a format 0 link to
	 * a format 1 note, which spends no read.
	 * @throws {SecretNetworkError} if the request never reached the server.
	 */
	async readNote(
		id: string,
		keyFragment: string,
		options?: ReadNoteOptions,
	): Promise<ReadNoteResult> {
		// The link names its format, so a malformed format 1 link spends no read,
		// and the server serves a note only in the format the read asks for.
		const format = formatOfFragment(keyFragment);
		if (format === 1) {
			assertFormat1Fragment(keyFragment);
		}
		options?.onProgress?.({ phase: "downloading", phaseProgress: 0, overallProgress: 0 });

		if (format === 1) {
			return this.readNoteFormat1(id, keyFragment, options);
		}

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

	/** Reports download progress, which fills the first part of the overall bar. */
	private downloadProgress(options?: ReadNoteOptions): (p: number) => void {
		return (p) => {
			options?.onDownloadProgress?.(p);
			options?.onProgress?.({
				phase: "downloading",
				phaseProgress: p,
				overallProgress: p * PROGRESS.downloadSpan,
			});
		};
	}

	/** Opens a downloaded note, reporting the decryption phase around it. */
	private async decrypting(
		open: () => Promise<NotePayload> | NotePayload,
		options?: ReadNoteOptions,
	): Promise<NotePayload> {
		options?.signal?.throwIfAborted();
		options?.onProgress?.({
			phase: "decrypting",
			phaseProgress: 0,
			overallProgress: PROGRESS.downloadSpan,
		});
		let payload: NotePayload;
		try {
			payload = await open();
		} catch (err) {
			throw uniformDecryptionError(err);
		}
		options?.onProgress?.({ phase: "decrypting", phaseProgress: 1, overallProgress: 1 });
		return payload;
	}

	private async readNoteRaw(
		id: string,
		keyFragment: string,
		options?: ReadNoteOptions,
	): Promise<ReadNoteResult> {
		const response = await http.getNoteRaw(
			this.configFor(options),
			id,
			this.downloadProgress(options),
		);
		const payload = await this.decrypting(
			() =>
				decryptNoteBytes(
					response.encryptedBytes,
					response.nonceBytes,
					keyFragment,
					options?.password,
					response.salt,
				),
			options,
		);
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
		const response = await http.getNote(this.configFor(options), id, options?.onDownloadProgress);

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
			throw uniformDecryptionError(err);
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
		const response = await http.getNoteStream(
			this.configFor(options),
			id,
			this.downloadProgress(options),
		);
		const payload = await this.decrypting(
			() =>
				decryptNoteChunked(
					response.chunks,
					response.streamHeader,
					keyFragment,
					options?.password,
					response.salt,
				),
			options,
		);
		return {
			payload,
			createdAt: response.createdAt,
			expiresAt: response.expiresAt,
			fileCount: response.fileCount,
		};
	}

	/**
	 * What reading a format 1 note takes: its envelope from `/exists`, then the
	 * proofs and the key derived from it with the link and the password.
	 */
	private async prepareRead(
		id: string,
		keyFragment: string,
		options?: ReadNoteOptions,
	): Promise<Format1Read> {
		const info = await http.checkNote(this.configFor(options), id);
		if (!info.exists) {
			throw new SecretApiError("Note not found", 404);
		}
		try {
			return await prepareFormat1Read(info.envelope, keyFragment, options?.password);
		} catch (err) {
			throw uniformDecryptionError(err);
		}
	}

	/**
	 * Reads a format 1 note: the proofs derived from its envelope, then the
	 * note, which the server serves only once the proofs check out.
	 */
	private async readNoteFormat1(
		id: string,
		keyFragment: string,
		options?: ReadNoteOptions,
	): Promise<ReadNoteResult> {
		const read = await this.prepareRead(id, keyFragment, options);
		try {
			const response = await sendingProofs(() =>
				http.postNoteRead(this.configFor(options), id, read.proofs, this.downloadProgress(options)),
			);
			const payload = await this.decrypting(() => openNoteFormat1(read, response.chunks), options);
			return {
				payload,
				createdAt: response.createdAt,
				expiresAt: response.expiresAt,
				// The envelope's, which the ciphertext authenticates, not the header's.
				fileCount: read.envelope.fileCount,
			};
		} finally {
			closeFormat1Read(read);
		}
	}

	/**
	 * Download a note and decrypt it into streams of the caller's, a file at a
	 * time as the download reaches it: a format 1 note is never held whole in
	 * memory, only the message being read. The text comes back in the result.
	 *
	 * **This consumes a read**, as {@link readNote} does, and takes the same
	 * link, password and options. Each file's stream is opened as the download
	 * reaches it, closed once the whole note is read and checked, and aborted
	 * on any failure: a reader shows nothing of a note before it knows the
	 * note whole (PROTOCOL.md), so until its stream is closed, what it holds is
	 * not the file. A file system's writable stream fits: written to a copy,
	 * committed on `close()`, dropped on `abort()`.
	 *
	 * A format 0 note is read whole, as {@link readNote} reads it, then written
	 * out.
	 *
	 * @throws What {@link readNote} throws; an error of a stream of the
	 * caller's is thrown as it is.
	 *
	 * @example
	 * ```ts
	 * const note = await client.readNoteInto(id, keyFragment, {
	 *   openFile: (file) => Writable.toWeb(createWriteStream(`/tmp/${file.name}.part`)),
	 * });
	 * ```
	 */
	async readNoteInto(
		id: string,
		keyFragment: string,
		options: ReadNoteIntoOptions,
	): Promise<ReadNoteIntoResult> {
		if (formatOfFragment(keyFragment) === 0) {
			const { payload, createdAt, expiresAt, fileCount } = await this.readNote(
				id,
				keyFragment,
				options,
			);
			const files = payload.files ?? [];
			await writeFiles(files, options.openFile);
			return {
				...(payload.text !== undefined ? { text: payload.text } : {}),
				...(payload.contentMode ? { contentMode: payload.contentMode } : {}),
				files: files.map(({ name, type, size }) => ({ name, type, size })),
				createdAt,
				expiresAt,
				fileCount,
			};
		}

		assertFormat1Fragment(keyFragment);
		options.onProgress?.({ phase: "downloading", phaseProgress: 0, overallProgress: 0 });
		const read = await this.prepareRead(id, keyFragment, options);
		try {
			const response = await sendingProofs(() =>
				http.postNoteReadStream(
					this.configFor(options),
					id,
					read.proofs,
					this.downloadProgress(options),
				),
			);
			let head: Format1Head;
			try {
				head = await streamNoteFormat1(read, response.messages, options.openFile);
			} catch (err) {
				// The download's failure, or a stream's of the caller, is not the note's.
				if (err instanceof OutsideFailure) {
					throw err.cause;
				}
				throw uniformDecryptionError(err);
			}
			options.onProgress?.({ phase: "decrypting", phaseProgress: 1, overallProgress: 1 });
			return {
				...head,
				createdAt: response.createdAt,
				expiresAt: response.expiresAt,
				fileCount: read.envelope.fileCount,
			};
		} finally {
			closeFormat1Read(read);
		}
	}

	/**
	 * Revoke a note before it expires, using the delete token from
	 * {@link createNote}. Idempotent from the caller's perspective only in that a
	 * second call reports 404.
	 *
	 * @throws {SecretApiError} 403 for a wrong token, 404 if the note is already gone.
	 * @throws {SecretNetworkError} if the request never reached the server.
	 */
	async deleteNote(
		id: string,
		deleteToken: string,
		capToken?: string,
		options?: RequestOptions,
	): Promise<void> {
		return http.deleteNote(this.configFor(options), id, deleteToken, capToken);
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

		const keyFragment = decodeUrlPart(parsed.hash.slice(1));
		if (!keyFragment) {
			throw new SecretValidationError("Invalid share URL: missing key fragment");
		}

		return { id: decodeUrlPart(id), keyFragment };
	}
}

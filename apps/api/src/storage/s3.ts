import {
	DeleteObjectCommand,
	DeleteObjectsCommand,
	GetObjectCommand,
	type GetObjectCommandOutput,
	NoSuchKey,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import {
	assertChunkCount,
	assertChunkIndex,
	StorageInvalidKeyError,
	StorageNotFoundError,
} from "./errors.js";
import type { StorageBackend } from "./interface.js";

export interface S3Config {
	readonly bucket: string;
	readonly region: string;
	readonly endpoint?: string;
	readonly accessKeyId: string;
	readonly secretAccessKey: string;
	readonly forcePathStyle: boolean;
}

const NOTE_ID_RE = /^[A-Za-z0-9_-]+$/;

function assertNoteId(noteId: string): void {
	if (!NOTE_ID_RE.test(noteId)) {
		throw new StorageInvalidKeyError("Invalid note ID for storage key");
	}
}

function isNotFoundError(err: unknown): boolean {
	if (err instanceof NoSuchKey) return true;
	if (err && typeof err === "object") {
		const e = err as {
			name?: unknown;
			$metadata?: { httpStatusCode?: unknown };
		};
		if (e.name === "NoSuchKey" || e.name === "NotFound") return true;
		if (e.$metadata?.httpStatusCode === 404) return true;
	}
	return false;
}

async function streamToBuffer(body: { transformToWebStream(): ReadableStream }): Promise<Buffer> {
	const chunks: Uint8Array[] = [];
	const stream = body.transformToWebStream();
	const reader = stream.getReader();

	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
	}

	return Buffer.concat(chunks);
}

export class S3Storage implements StorageBackend {
	private readonly client: S3Client;
	private readonly bucket: string;

	constructor(config: S3Config) {
		this.bucket = config.bucket;
		this.client = new S3Client({
			region: config.region,
			...(config.endpoint ? { endpoint: config.endpoint } : {}),
			forcePathStyle: config.forcePathStyle,
			credentials: {
				accessKeyId: config.accessKeyId,
				secretAccessKey: config.secretAccessKey,
			},
		});
	}

	async save(noteId: string, data: Buffer): Promise<string> {
		assertNoteId(noteId);
		const key = `notes/${noteId}`;
		const upload = new Upload({
			client: this.client,
			params: {
				Bucket: this.bucket,
				Key: key,
				Body: data,
				ContentType: "application/octet-stream",
			},
		});
		await upload.done();
		return key;
	}

	async read(storageKey: string): Promise<Buffer> {
		let response: GetObjectCommandOutput;
		try {
			response = await this.client.send(
				new GetObjectCommand({
					Bucket: this.bucket,
					Key: storageKey,
				}),
			);
		} catch (err) {
			if (isNotFoundError(err)) throw new StorageNotFoundError();
			throw err;
		}

		if (!response.Body) {
			throw new StorageNotFoundError("Empty response from S3");
		}

		return streamToBuffer(response.Body);
	}

	async delete(storageKey: string): Promise<void> {
		try {
			await this.client.send(
				new DeleteObjectCommand({
					Bucket: this.bucket,
					Key: storageKey,
				}),
			);
		} catch {
			/* object already deleted or missing */
		}
	}

	async saveChunk(noteId: string, chunkIndex: number, data: Buffer): Promise<string> {
		assertNoteId(noteId);
		assertChunkIndex(chunkIndex);
		const key = `notes/${noteId}/chunk_${String(chunkIndex)}`;
		await this.client.send(
			new PutObjectCommand({
				Bucket: this.bucket,
				Key: key,
				Body: data,
				ContentType: "application/octet-stream",
			}),
		);
		return key;
	}

	async readChunk(noteId: string, chunkIndex: number): Promise<Buffer> {
		assertNoteId(noteId);
		assertChunkIndex(chunkIndex);
		const key = `notes/${noteId}/chunk_${String(chunkIndex)}`;
		let response: GetObjectCommandOutput;
		try {
			response = await this.client.send(
				new GetObjectCommand({
					Bucket: this.bucket,
					Key: key,
				}),
			);
		} catch (err) {
			if (isNotFoundError(err)) throw new StorageNotFoundError();
			throw err;
		}

		if (!response.Body) {
			throw new StorageNotFoundError("Empty response from S3");
		}

		return streamToBuffer(response.Body);
	}

	async deleteChunks(noteId: string, chunkCount: number): Promise<void> {
		assertNoteId(noteId);
		assertChunkCount(chunkCount);
		const objects = Array.from({ length: chunkCount }, (_, i) => ({
			Key: `notes/${noteId}/chunk_${String(i)}`,
		}));

		// S3 DeleteObjects supports up to 1000 keys per batch
		for (let start = 0; start < objects.length; start += 1000) {
			const batch = objects.slice(start, start + 1000);
			try {
				await this.client.send(
					new DeleteObjectsCommand({
						Bucket: this.bucket,
						Delete: { Objects: batch, Quiet: true },
					}),
				);
			} catch {
				/* batch delete failed — individual chunks may remain */
			}
		}
	}

	async close(): Promise<void> {
		this.client.destroy();
	}
}

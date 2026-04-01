import {
	DeleteObjectCommand,
	GetObjectCommand,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { StorageBackend } from "./interface.js";

export interface S3Config {
	readonly bucket: string;
	readonly region: string;
	readonly endpoint?: string;
	readonly accessKeyId: string;
	readonly secretAccessKey: string;
	readonly forcePathStyle: boolean;
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
		if (!/^[A-Za-z0-9_-]+$/.test(noteId)) {
			throw new Error("Invalid note ID for storage key");
		}
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
		const response = await this.client.send(
			new GetObjectCommand({
				Bucket: this.bucket,
				Key: storageKey,
			}),
		);

		if (!response.Body) {
			throw new Error("Empty response from S3");
		}

		const chunks: Uint8Array[] = [];
		const stream = response.Body.transformToWebStream();
		const reader = stream.getReader();

		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
		}

		return Buffer.concat(chunks);
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
		if (!/^[A-Za-z0-9_-]+$/.test(noteId)) {
			throw new Error("Invalid note ID for storage key");
		}
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
		const key = `notes/${noteId}/chunk_${String(chunkIndex)}`;
		const response = await this.client.send(
			new GetObjectCommand({
				Bucket: this.bucket,
				Key: key,
			}),
		);

		if (!response.Body) {
			throw new Error("Empty response from S3");
		}

		const chunks: Uint8Array[] = [];
		const stream = response.Body.transformToWebStream();
		const reader = stream.getReader();

		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
		}

		return Buffer.concat(chunks);
	}

	async deleteChunks(noteId: string, chunkCount: number): Promise<void> {
		for (let i = 0; i < chunkCount; i++) {
			try {
				await this.client.send(
					new DeleteObjectCommand({
						Bucket: this.bucket,
						Key: `notes/${noteId}/chunk_${String(i)}`,
					}),
				);
			} catch {
				/* chunk already deleted or missing */
			}
		}
	}
}

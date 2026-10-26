import {
	DeleteObjectCommand,
	DeleteObjectsCommand,
	GetObjectCommand,
	type GetObjectCommandOutput,
	HeadBucketCommand,
	ListObjectsV2Command,
	NoSuchKey,
	PutObjectCommand,
	S3Client,
	type _Object as S3Object,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { isValidNoteId } from "@largerio/secret-shared";
import { runWithConcurrency } from "../concurrency.js";
import { assertChunkIndex, assertId, StorageError, StorageNotFoundError } from "./errors.js";
import type { StorageBackend, StoredNote } from "./interface.js";

export interface S3Config {
	readonly bucket: string;
	readonly region: string;
	readonly endpoint?: string;
	readonly accessKeyId: string;
	readonly secretAccessKey: string;
	readonly forcePathStyle: boolean;
}

const NOTES_PREFIX = "notes/";
const CLAIMS_PREFIX = "instances/";
// Parallel single deletes when a server refuses the batch call.
const DELETE_CONCURRENCY = 8;

// notes/<id> holds a file note; notes/<id>/chunk_<n> the chunks of a chunked one.
const NOTE_KEY_RE = /^notes\/([A-Za-z0-9_-]+)(?:\/chunk_\d+)?$/;

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

	async probe(): Promise<void> {
		// HeadBucket exercises endpoint reachability and credential validity in
		// one cheap call — the two things that silently rot after a key rotation.
		await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
	}

	async save(noteId: string, data: Buffer): Promise<string> {
		assertId(noteId);
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

	async saveChunk(noteId: string, chunkIndex: number, data: Buffer): Promise<string> {
		assertId(noteId);
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
		assertId(noteId);
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

	async purge(noteId: string): Promise<void> {
		assertId(noteId);
		// A file note is one object, deleted without looking first: a DELETE of
		// a missing key succeeds. A chunked note's chunks sit under its id.
		await this.deleteKey(`${NOTES_PREFIX}${noteId}`);
		for await (const objects of this.listPages(`${NOTES_PREFIX}${noteId}/`)) {
			const keys = objects.flatMap(({ Key: key }) => (key ? [key] : []));
			if (keys.length > 0) {
				await this.deleteKeys(keys);
			}
		}
	}

	async *list(): AsyncIterable<StoredNote> {
		// Keys come back in order, so a note's objects sit next to each other:
		// they fold into one entry, dated by the latest write.
		let current: StoredNote | undefined;
		for await (const objects of this.listPages(NOTES_PREFIX)) {
			for (const { Key: key, LastModified: lastModified } of objects) {
				const noteId = NOTE_KEY_RE.exec(key ?? "")?.[1];
				if (noteId === undefined || lastModified === undefined || !isValidNoteId(noteId)) {
					continue;
				}
				if (current?.noteId === noteId) {
					current = lastModified > current.lastModified ? { noteId, lastModified } : current;
					continue;
				}
				if (current) {
					yield current;
				}
				current = { noteId, lastModified };
			}
		}
		if (current) {
			yield current;
		}
	}

	async claim(instanceId: string): Promise<void> {
		assertId(instanceId);
		// An empty Buffer, not "": the SDK cannot size a string body and warns.
		await this.client.send(
			new PutObjectCommand({
				Bucket: this.bucket,
				Key: `${CLAIMS_PREFIX}${instanceId}`,
				Body: Buffer.alloc(0),
			}),
		);
	}

	async listClaims(): Promise<string[]> {
		const claims: string[] = [];
		for await (const objects of this.listPages(CLAIMS_PREFIX)) {
			for (const { Key: key } of objects) {
				if (key && key.length > CLAIMS_PREFIX.length) {
					claims.push(key.slice(CLAIMS_PREFIX.length));
				}
			}
		}
		return claims;
	}

	private async *listPages(prefix: string): AsyncIterable<S3Object[]> {
		let continuationToken: string | undefined;
		do {
			const page = await this.client.send(
				new ListObjectsV2Command({
					Bucket: this.bucket,
					Prefix: prefix,
					...(continuationToken ? { ContinuationToken: continuationToken } : {}),
				}),
			);
			yield page.Contents ?? [];
			continuationToken = page.NextContinuationToken;
		} while (continuationToken);
	}

	private async deleteKey(key: string): Promise<void> {
		try {
			await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
		} catch (err) {
			if (!isNotFoundError(err)) {
				throw err;
			}
		}
	}

	// Takes at most 1000 keys, the DeleteObjects limit — one listing page.
	private async deleteKeys(keys: string[]): Promise<void> {
		let errors: Array<{ Code?: string | undefined }>;
		try {
			({ Errors: errors = [] } = await this.client.send(
				new DeleteObjectsCommand({
					Bucket: this.bucket,
					Delete: { Objects: keys.map((key) => ({ Key: key })), Quiet: true },
				}),
			));
		} catch {
			// The batch call needs a checksum header, and not every S3 server
			// accepts the one the SDK sends. One DELETE per key works everywhere;
			// a failure there is the one that counts.
			await runWithConcurrency(keys, DELETE_CONCURRENCY, (key) => this.deleteKey(key));
			return;
		}
		// A refused key only shows up here, in a 200 response: unread, the
		// purge would pass for done and the object stay behind.
		const refused = errors.filter((error) => error.Code !== "NoSuchKey");
		const [first] = refused;
		if (first) {
			throw new StorageError(
				`S3 refused to delete ${String(refused.length)} object(s): ${first.Code ?? "unknown error"}`,
			);
		}
	}

	async close(): Promise<void> {
		this.client.destroy();
	}
}

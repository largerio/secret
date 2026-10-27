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

/**
 * How long S3 is waited on. connectionMs and idleMs bound silence, not
 * transfer time: an upload keeps its socket busy however large and slow it
 * is. They apply to each attempt, and the SDK makes three in all. requestMs
 * and probeMs are deadlines, retries included.
 */
export interface S3Timeouts {
	/** Establishing the TCP connection, on each attempt. */
	readonly connectionMs: number;
	/**
	 * Not a byte either way on an open request, on each attempt, such as a
	 * server that took the request and never answers, or a body that stops
	 * arriving.
	 */
	readonly idleMs: number;
	/**
	 * A request that moves no note payload (a listing, a delete, a claim),
	 * retries included. Above 6 s the SDK drops its idle timeout once the
	 * headers are in, so a body that stopped arriving after them would hold
	 * the request, and the purge or sweep behind it, for good. A read has a
	 * guard of its own (streamToBuffer), and an upload takes as long as its
	 * size makes it.
	 */
	readonly requestMs: number;
	/** The health probe, retries included. */
	readonly probeMs: number;
}

export const S3_TIMEOUTS: S3Timeouts = {
	connectionMs: 5_000,
	// Above the 6 s the SDK waits for a 100 Continue before sending a body
	// anyway, and above what a server takes to delete 1000 keys in one call.
	idleMs: 30_000,
	// Above three attempts that each wait out connectionMs and idleMs, 105 s,
	// so the SDK's own retries run their course first, and well above what a
	// slow server takes to delete 1000 keys in one call.
	requestMs: 120_000,
	// HeadBucket answers in well under a second: a storage this slow cannot
	// serve notes either.
	probeMs: 5_000,
};

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

/**
 * Read a response body whole, giving up when it stalls. The SDK's own idle
 * timeout cannot see this: above 6 s it is set 3 s into the request and
 * dropped once the headers are in, so a body that stopped arriving after a
 * quick answer would hang the request for good.
 */
async function streamToBuffer(
	body: { transformToWebStream(): ReadableStream },
	idleMs: number,
): Promise<Buffer> {
	const chunks: Uint8Array[] = [];
	const reader = body.transformToWebStream().getReader();

	for (;;) {
		const { done, value } = await readWithin(reader, idleMs);
		if (done) break;
		chunks.push(value);
	}

	return Buffer.concat(chunks);
}

async function readWithin<T>(
	reader: ReadableStreamDefaultReader<T>,
	idleMs: number,
): Promise<ReadableStreamReadResult<T>> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const stalled = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			reject(new StorageError(`S3 response stalled for ${String(idleMs / 1000)} s`));
			// Ends the response and closes its connection. A rejection here
			// would go unhandled and take the process down.
			reader.cancel().catch(() => undefined);
		}, idleMs);
	});

	try {
		return await Promise.race([reader.read(), stalled]);
	} finally {
		clearTimeout(timer);
	}
}

export class S3Storage implements StorageBackend {
	private readonly client: S3Client;
	private readonly bucket: string;
	private readonly timeouts: S3Timeouts;

	constructor(config: S3Config, timeouts: S3Timeouts = S3_TIMEOUTS) {
		this.bucket = config.bucket;
		this.timeouts = timeouts;
		this.client = new S3Client({
			region: config.region,
			...(config.endpoint ? { endpoint: config.endpoint } : {}),
			forcePathStyle: config.forcePathStyle,
			credentials: {
				accessKeyId: config.accessKeyId,
				secretAccessKey: config.secretAccessKey,
			},
			// Without these, an endpoint that hangs holds user requests, the
			// health probe, purges and the sweep for good. The SDK retries a
			// timeout like a reset connection, three attempts in all: the usual
			// culprit is one dead pooled connection, which the next attempt
			// replaces, and the SDK's retry quota stops retrying once failures
			// pile up. Not requestTimeout: it bounds the whole request, which a
			// slow upload can outlast, and only warns unless told to throw.
			requestHandler: {
				connectionTimeout: timeouts.connectionMs,
				socketTimeout: timeouts.idleMs,
			},
		});
	}

	async probe(): Promise<void> {
		// HeadBucket exercises endpoint reachability and credential validity in
		// one cheap call — the two things that silently rot after a key rotation.
		// The deadline covers the retries: the endpoint answers or it is down.
		await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }), {
			abortSignal: AbortSignal.timeout(this.timeouts.probeMs),
		});
	}

	/**
	 * The options of a request that moves no note payload: a deadline of its
	 * own, retries included (see S3Timeouts.requestMs). Once it passes, the
	 * request fails with an AbortError, which callers take like any other
	 * storage failure: a purge stays queued for a retry.
	 */
	private deadline(): { abortSignal: AbortSignal } {
		return { abortSignal: AbortSignal.timeout(this.timeouts.requestMs) };
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

		return streamToBuffer(response.Body, this.timeouts.idleMs);
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

		return streamToBuffer(response.Body, this.timeouts.idleMs);
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
			this.deadline(),
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
				this.deadline(),
			);
			yield page.Contents ?? [];
			continuationToken = page.NextContinuationToken;
		} while (continuationToken);
	}

	private async deleteKey(key: string): Promise<void> {
		try {
			await this.client.send(
				new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
				this.deadline(),
			);
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
				this.deadline(),
			));
		} catch {
			// The batch call needs a checksum header, and not every S3 server
			// accepts the one the SDK sends; some take too long over it. One
			// DELETE per key works everywhere; a failure there is the one that
			// counts.
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

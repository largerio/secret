import type { CreateNoteResult, NoteInfo, ProgressInfo } from "@largerio/secret-sdk";
import {
	type Answer,
	type CreateOptions,
	type ReadResult,
	type Request,
	receivedError,
} from "#lib/notes/protocol.js";
import { LOCK_PREFIX, removeStaged, sweepStaged } from "#lib/notes/staging.js";

type Send = (request: Request) => void;

/** Each request as a page makes it: the call's number is added on the way out. */
type WithoutCall<T> = T extends unknown ? Omit<T, "call"> : never;
type Asked = WithoutCall<Request>;

interface Pending {
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
	readonly onProgress: ((info: ProgressInfo) => void) | undefined;
}

const pending = new Map<number, Pending>();
let calls = 0;
let connection: Promise<Send> | undefined;

/** Delivers an answer to the call it names. */
function deliver(answer: Answer): void {
	if (answer.kind === "ready") {
		return;
	}
	const call = pending.get(answer.call);
	if (call === undefined) {
		return;
	}
	if (answer.kind === "progress") {
		call.onProgress?.(answer.info);
		return;
	}
	pending.delete(answer.call);
	if (answer.kind === "result") {
		call.resolve(answer.value);
	} else {
		call.reject(receivedError(answer.error));
	}
}

/**
 * Starts the worker, resolved once it says it is ready. A worker that fails to
 * start (a script that does not load) says nothing, and rejects; one that
 * fails later fails the calls it was answering.
 */
function startWorker(): Promise<Send> {
	return new Promise((resolve, reject) => {
		const worker = new Worker(new URL("./notes.worker.ts", import.meta.url), { type: "module" });
		let ready = false;
		worker.addEventListener("message", (event: MessageEvent<Answer>) => {
			if (event.data.kind === "ready") {
				ready = true;
				resolve((request) => worker.postMessage(request));
			}
			deliver(event.data);
		});
		worker.addEventListener("error", () => {
			if (!ready) {
				worker.terminate();
				reject(new Error("The worker did not start"));
				return;
			}
			for (const [call, { reject: fail }] of pending) {
				pending.delete(call);
				fail(new Error("The worker stopped"));
			}
		});
	});
}

/**
 * The worker, started on the first call. The SDK runs only there: a page that
 * imported it too would load libsodium for nothing, and the bundler then puts
 * it in the chunk every page loads. A worker that did not start is tried again
 * on the next call.
 */
function connect(): Promise<Send> {
	connection ??= startWorker().catch((err: unknown) => {
		connection = undefined;
		throw err;
	});
	return connection;
}

async function ask<T>(request: Asked, onProgress?: (info: ProgressInfo) => void): Promise<T> {
	const send = await connect();
	const call = ++calls;
	return new Promise<T>((resolve, reject) => {
		pending.set(call, { resolve: resolve as (value: unknown) => void, reject, onProgress });
		send({ ...request, call } as Request);
	});
}

/** Encrypts and sends a note, its files read from disk as they are encrypted. */
export function createNote(
	options: CreateOptions,
	onProgress?: (info: ProgressInfo) => void,
): Promise<CreateNoteResult> {
	return ask({ kind: "create", options }, onProgress);
}

/** Where a note stands, read or not: spends nothing. */
export function checkNote(id: string): Promise<NoteInfo> {
	return ask({ kind: "check", id });
}

/** Deletes a note with its delete token. */
export function deleteNote(id: string, deleteToken: string, capToken?: string): Promise<void> {
	return ask({ kind: "delete", id, deleteToken, ...(capToken ? { capToken } : {}) });
}

/** A note read, as long as the page shows it. */
export interface OpenedNote extends ReadResult {
	/** Deletes its files from disk: the URLs made of them must be revoked first. */
	close(): Promise<void>;
}

/**
 * Reads a note, its files decrypted to disk where the browser allows it. The
 * page holds the read's lock until it closes the note, so that no other page
 * sweeps the files away while they are shown; it sweeps what the reads of
 * pages gone left behind.
 */
export async function readNote(
	id: string,
	keyFragment: string,
	options: {
		readonly password?: string;
		readonly chunked?: boolean;
		readonly onProgress?: (info: ProgressInfo) => void;
	} = {},
): Promise<OpenedNote> {
	const readId = randomId();
	const release = await holdLock(`${LOCK_PREFIX}${readId}`);
	void sweepStaged().catch(() => undefined);
	const close = async () => {
		await removeStaged(readId);
		release();
	};
	try {
		const note = await ask<ReadResult>(
			{
				kind: "read",
				id,
				keyFragment,
				readId,
				...(options.password ? { password: options.password } : {}),
				...(options.chunked !== undefined ? { chunked: options.chunked } : {}),
			},
			options.onProgress,
		);
		return { ...note, close };
	} catch (err) {
		await close();
		throw err;
	}
}

/** 16 random bytes in hex: `crypto.randomUUID` needs a secure context, which a LAN instance may not be. */
function randomId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Takes a lock until the function returned is called. Without Web Locks (a
 * page over plain HTTP), there is nothing to hold, and nothing is swept.
 */
async function holdLock(name: string): Promise<() => void> {
	const locks = navigator.locks as LockManager | undefined;
	if (locks === undefined) {
		return () => undefined;
	}
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	// Refused, the lock is not held: the read goes on without it.
	await new Promise<void>((granted) => {
		locks
			.request(name, () => {
				granted();
				return held;
			})
			.catch(() => granted());
	});
	return release;
}

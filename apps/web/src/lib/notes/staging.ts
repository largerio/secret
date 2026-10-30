import type { ReadNoteIntoOptions } from "@largerio/secret-sdk";

/**
 * Where reads stage their files, in the origin's private file system: one
 * directory per read, named by its id.
 */
const STAGING = "reads";
/** The lock a page holds while a read's files are in use (Web Locks), named after the read. */
export const LOCK_PREFIX = "secret-read:";
/** Room kept free past a file on disk, for the browser's own needs. */
const MARGIN = 16 * 1024 * 1024;

/** A file's synchronous access, which only a dedicated worker gets. */
interface SyncAccess {
	write(buffer: Uint8Array, options: { at: number }): number;
	flush(): void;
	close(): void;
}

interface Sink {
	readonly stream: WritableStream<Uint8Array>;
	/** The file, once its stream is closed. */
	readonly blob: () => Promise<Blob>;
}

export interface Staging {
	readonly openFile: ReadNoteIntoOptions["openFile"];
	/** Each file, in order, once every stream is closed. */
	files(): Promise<Blob[]>;
}

/**
 * Where a read puts the files it decrypts: on disk, in a directory of its own
 * in the origin's private file system, so that a large note is never held in
 * memory; in memory where that file system is missing (an older browser, a
 * private window, a page served over plain HTTP), where only the main thread
 * runs, or where the disk lacks room for a file. A stream aborted takes its
 * file with it.
 */
export async function openStaging(
	readId: string,
	storage: StorageManager = navigator.storage,
): Promise<Staging> {
	const directory = await stagingDirectory(readId, storage, true);
	const blobs: Array<Sink["blob"]> = [];
	return {
		openFile: async (file, index) => {
			const disk = directory && (await diskSink(directory, index, file, storage));
			const sink = disk ?? memorySink(file.type);
			blobs[index] = sink.blob;
			return sink.stream;
		},
		files: () => Promise.all(blobs.map((blob) => blob())),
	};
}

/** The directory of a read's files, or of every read's; undefined without a private file system. */
async function stagingDirectory(
	readId: string | undefined,
	storage: StorageManager,
	create: boolean,
): Promise<FileSystemDirectoryHandle | undefined> {
	try {
		const reads = await (await storage.getDirectory()).getDirectoryHandle(STAGING, { create });
		return readId === undefined ? reads : await reads.getDirectoryHandle(readId, { create });
	} catch {
		return undefined;
	}
}

async function hasRoomFor(size: number, storage: StorageManager): Promise<boolean> {
	const { quota, usage } = await storage.estimate();
	return quota === undefined || usage === undefined || quota - usage > size + MARGIN;
}

/**
 * A file written straight to disk, or undefined where it cannot be: outside a
 * worker, short of room, or refused. The read is spent by now: a file the disk
 * refuses goes to memory rather than fail it.
 */
async function diskSink(
	directory: FileSystemDirectoryHandle,
	index: number,
	file: { readonly type: string; readonly size: number },
	storage: StorageManager,
): Promise<Sink | undefined> {
	try {
		return await openOnDisk(directory, String(index), file, storage);
	} catch {
		return undefined;
	}
}

async function openOnDisk(
	directory: FileSystemDirectoryHandle,
	name: string,
	{ type, size }: { readonly type: string; readonly size: number },
	storage: StorageManager,
): Promise<Sink | undefined> {
	if (!(await hasRoomFor(size, storage))) {
		return undefined;
	}
	const handle = await directory.getFileHandle(name, { create: true });
	const open = (handle as { createSyncAccessHandle?: () => Promise<SyncAccess> })
		.createSyncAccessHandle;
	if (open === undefined) {
		return undefined;
	}
	const access = await open.call(handle);
	let at = 0;
	return {
		stream: new WritableStream({
			write: (chunk) => {
				at += access.write(chunk, { at });
			},
			close: () => {
				access.flush();
				access.close();
			},
			abort: async () => {
				access.close();
				await directory.removeEntry(name);
			},
		}),
		// The note's type over the bytes on disk: wrapping a Blob copies nothing.
		blob: async () => new Blob([await handle.getFile()], { type }),
	};
}

function memorySink(type: string): Sink {
	const chunks: Uint8Array[] = [];
	return {
		stream: new WritableStream({
			write: (chunk) => {
				chunks.push(chunk);
			},
			abort: () => {
				chunks.length = 0;
			},
		}),
		blob: async () => new Blob(chunks as BlobPart[], { type }),
	};
}

/** Deletes a read's files: the URLs made of them must be revoked first. */
export async function removeStaged(
	readId: string,
	storage: StorageManager = navigator.storage,
): Promise<void> {
	const reads = await stagingDirectory(undefined, storage, false);
	await reads?.removeEntry(readId, { recursive: true }).catch(() => undefined);
}

/**
 * Deletes the files of reads no page holds any more: a tab closed, or one
 * that crashed, before it deleted its own. A page holds a read's lock as long
 * as it shows the note, and the browser releases the locks of a page that is
 * gone, however it went.
 */
export async function sweepStaged(
	storage: StorageManager = navigator.storage,
	locks: LockManager | undefined = navigator.locks,
): Promise<void> {
	const reads = await stagingDirectory(undefined, storage, false);
	if (reads === undefined || locks === undefined) {
		return;
	}
	const { held = [], pending = [] } = await locks.query();
	const live = new Set([...held, ...pending].map((lock) => lock.name));
	for await (const name of reads.keys()) {
		if (!live.has(`${LOCK_PREFIX}${name}`)) {
			await reads.removeEntry(name, { recursive: true }).catch(() => undefined);
		}
	}
}

import { describe, expect, it, vi } from "vitest";
import { LOCK_PREFIX, openStaging, removeStaged, sweepStaged } from "../staging.js";

/** A file of a private file system, its bytes in memory. */
class FakeFile {
	bytes = new Uint8Array(0);
	constructor(
		readonly name: string,
		private readonly sync: boolean,
	) {}

	async getFile(): Promise<File> {
		return new File([this.bytes as BlobPart], this.name);
	}

	get createSyncAccessHandle() {
		if (!this.sync) return undefined;
		return async () => ({
			write: (buffer: Uint8Array, { at }: { at: number }) => {
				const grown = new Uint8Array(Math.max(this.bytes.length, at + buffer.length));
				grown.set(this.bytes);
				grown.set(buffer, at);
				this.bytes = grown;
				return buffer.length;
			},
			flush: vi.fn(),
			close: vi.fn(),
		});
	}
}

/** A directory of a private file system. */
class FakeDirectory {
	readonly entries = new Map<string, FakeDirectory | FakeFile>();
	constructor(private readonly sync = true) {}

	async getDirectoryHandle(name: string, options?: { create?: boolean }) {
		let entry = this.entries.get(name);
		if (entry === undefined) {
			if (!options?.create) throw new DOMException("missing", "NotFoundError");
			entry = new FakeDirectory(this.sync);
			this.entries.set(name, entry);
		}
		return entry;
	}

	async getFileHandle(name: string, options?: { create?: boolean }) {
		let entry = this.entries.get(name);
		if (entry === undefined && options?.create) {
			entry = new FakeFile(name, this.sync);
			this.entries.set(name, entry);
		}
		return entry;
	}

	removeEntry = vi.fn(async (name: string) => {
		this.entries.delete(name);
	});

	async *keys() {
		yield* [...this.entries.keys()];
	}
}

function fakeStorage(options: { sync?: boolean; free?: number; quota?: boolean } = {}) {
	const root = new FakeDirectory(options.sync ?? true);
	const storage = {
		getDirectory: async () => root,
		estimate: async () =>
			options.quota === false ? {} : { quota: (options.free ?? 1 << 30) + 1000, usage: 1000 },
	} as unknown as StorageManager;
	const reads = () => root.entries.get("reads") as FakeDirectory | undefined;
	return { root, storage, reads };
}

const file = (size: number, type = "image/png") => ({ name: "photo.png", type, size });

async function write(stream: WritableStream<Uint8Array>, ...chunks: number[][]) {
	const writer = stream.getWriter();
	for (const chunk of chunks) await writer.write(new Uint8Array(chunk));
	return writer;
}

const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

describe("staging a read's files", () => {
	it("writes each file to disk, in a directory of the read's, under the note's type", async () => {
		const { storage, reads } = fakeStorage();
		const staging = await openStaging("read1", storage);

		const first = await write(await staging.openFile(file(3), 0), [1, 2], [3]);
		await first.close();
		const second = await write(await staging.openFile(file(1, "text/plain"), 1), [9]);
		await second.close();

		const staged = reads()?.entries.get("read1") as FakeDirectory;
		expect([...staged.entries.keys()]).toEqual(["0", "1"]);
		expect((staged.entries.get("0") as FakeFile).bytes).toEqual(new Uint8Array([1, 2, 3]));
		const [photo, text] = await staging.files();
		expect(photo?.type).toBe("image/png");
		expect(await bytesOf(photo as Blob)).toEqual(new Uint8Array([1, 2, 3]));
		expect(text?.type).toBe("text/plain");
	});

	it("deletes a file whose stream is aborted", async () => {
		const { storage, reads } = fakeStorage();
		const staging = await openStaging("read1", storage);

		const writer = await write(await staging.openFile(file(3), 0), [1]);
		await writer.abort(new Error("refused"));

		const staged = reads()?.entries.get("read1") as FakeDirectory;
		expect([...staged.entries.keys()]).toEqual([]);
	});

	it.each([
		["without a private file system", { storage: {} as StorageManager }],
		["on the main thread, which gets no synchronous access", fakeStorage({ sync: false })],
		["without room for the file", fakeStorage({ free: 1000 })],
	])("keeps the files in memory %s", async (_, { storage }) => {
		const staging = await openStaging("read1", storage);

		const writer = await write(await staging.openFile(file(3), 0), [1, 2], [3]);
		await writer.close();

		const [blob] = await staging.files();
		expect(blob?.type).toBe("image/png");
		expect(await bytesOf(blob as Blob)).toEqual(new Uint8Array([1, 2, 3]));
	});

	it.each([
		["the quota cannot be told", "estimate"],
		["the file cannot be opened", "getFileHandle"],
	] as const)("keeps a file in memory when %s", async (_, failing) => {
		const { storage, root } = fakeStorage();
		const staging = await openStaging("read1", storage);
		const reads = root.entries.get("reads") as FakeDirectory;
		const staged = reads.entries.get("read1") as FakeDirectory;
		const refused = () => Promise.reject(new DOMException("no", "InvalidStateError"));
		if (failing === "estimate") vi.spyOn(storage, "estimate").mockImplementation(refused);
		else vi.spyOn(staged, "getFileHandle").mockImplementation(refused);

		await (await write(await staging.openFile(file(1), 0), [5])).close();

		expect(staged.entries.size).toBe(0);
		expect(await bytesOf((await staging.files())[0] as Blob)).toEqual(new Uint8Array([5]));
	});

	it("writes to disk when the browser tells no quota", async () => {
		const { storage, reads } = fakeStorage({ quota: false });
		const staging = await openStaging("read1", storage);

		await (await write(await staging.openFile(file(1), 0), [1])).close();

		expect(reads()?.entries.get("read1")).toBeDefined();
	});

	it("drops what a file kept in memory once its stream is aborted", async () => {
		const staging = await openStaging("read1", {} as StorageManager);

		const writer = await write(await staging.openFile(file(3), 0), [1, 2]);
		await writer.abort(new Error("refused"));

		const [blob] = await staging.files();
		expect(blob?.size).toBe(0);
	});
});

describe("removing a read's files", () => {
	it("deletes its directory", async () => {
		const { storage, reads } = fakeStorage();
		await openStaging("read1", storage);
		await openStaging("read2", storage);

		await removeStaged("read1", storage);

		expect([...(reads()?.entries.keys() ?? [])]).toEqual(["read2"]);
	});

	it("does nothing where nothing was staged", async () => {
		await expect(removeStaged("read1", fakeStorage().storage)).resolves.toBeUndefined();
		await expect(removeStaged("read1", {} as StorageManager)).resolves.toBeUndefined();
	});

	it("does not fail when the directory cannot be deleted", async () => {
		const { storage, reads } = fakeStorage();
		await openStaging("read1", storage);
		reads()?.removeEntry.mockRejectedValueOnce(
			new DOMException("busy", "InvalidModificationError"),
		);

		await expect(removeStaged("read1", storage)).resolves.toBeUndefined();
	});
});

describe("sweeping what reads left behind", () => {
	const locks = (held: string[], pending: string[] = []) =>
		({
			query: async () => ({
				held: held.map((name) => ({ name })),
				pending: pending.map((name) => ({ name })),
			}),
		}) as unknown as LockManager;

	it("deletes the reads no page holds, and keeps the others", async () => {
		const { storage, reads } = fakeStorage();
		for (const id of ["gone", "shown", "starting"]) await openStaging(id, storage);

		await sweepStaged(storage, locks([`${LOCK_PREFIX}shown`], [`${LOCK_PREFIX}starting`]));

		expect([...(reads()?.entries.keys() ?? [])]).toEqual(["shown", "starting"]);
	});

	it("goes on past a read it cannot delete", async () => {
		const { storage, reads } = fakeStorage();
		for (const id of ["first", "second"]) await openStaging(id, storage);
		reads()?.removeEntry.mockRejectedValueOnce(
			new DOMException("busy", "InvalidModificationError"),
		);

		await sweepStaged(storage, { query: async () => ({}) } as unknown as LockManager);

		expect([...(reads()?.entries.keys() ?? [])]).toEqual(["first"]);
	});

	it("deletes nothing without locks to tell the reads still shown", async () => {
		const { storage, reads } = fakeStorage();
		await openStaging("read1", storage);

		await sweepStaged(storage, undefined);

		expect(reads()?.entries.has("read1")).toBe(true);
	});

	it("does nothing where nothing was staged", async () => {
		await expect(sweepStaged(fakeStorage().storage, locks([]))).resolves.toBeUndefined();
	});
});

describe("the browser's own storage", () => {
	it("is where staging goes by default, memory where the browser has none", async () => {
		const staging = await openStaging("read1");
		await (await write(await staging.openFile(file(1), 0), [7])).close();

		expect(await bytesOf((await staging.files())[0] as Blob)).toEqual(new Uint8Array([7]));
		await expect(removeStaged("read1")).resolves.toBeUndefined();
		await expect(sweepStaged()).resolves.toBeUndefined();
	});
});

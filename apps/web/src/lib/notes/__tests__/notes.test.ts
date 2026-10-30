import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Answer, Request } from "../protocol.js";

const removeStaged = vi.fn();
const sweepStaged = vi.fn();
vi.mock("../staging.js", () => ({
	LOCK_PREFIX: "secret-read:",
	removeStaged: (readId: string) => removeStaged(readId),
	sweepStaged: () => sweepStaged(),
}));

/** How the fake worker answers each request: by default, with nothing. */
let respond: (request: Request, worker: FakeWorker) => void;

/** A worker as the page sees one: it says it is ready, then answers its requests. */
class FakeWorker extends EventTarget {
	static started: FakeWorker[] = [];
	static failToStart = false;
	readonly terminate = vi.fn();

	constructor(
		readonly url: URL,
		readonly options: WorkerOptions,
	) {
		super();
		FakeWorker.started.push(this);
		queueMicrotask(() => {
			if (FakeWorker.failToStart) {
				this.dispatchEvent(new Event("error"));
				return;
			}
			this.answer({ kind: "ready" });
		});
	}

	postMessage(request: Request): void {
		queueMicrotask(() => respond(request, this));
	}

	answer(answer: Answer): void {
		this.dispatchEvent(new MessageEvent("message", { data: answer }));
	}
}

/** Web Locks, recording which locks are held and taking them at once. */
function fakeLocks() {
	const held = new Set<string>();
	const locks = {
		request: vi.fn(async (name: string, callback: () => Promise<void>) => {
			held.add(name);
			await callback();
			held.delete(name);
		}),
	};
	return { held, locks };
}

/** The module afresh, with the SDK's errors of the same load. */
async function load() {
	const { SecretDecryptionError } = await import("@largerio/secret-sdk");
	return { ...(await import("../notes.js")), SecretDecryptionError };
}

beforeEach(() => {
	vi.resetModules();
	FakeWorker.started = [];
	FakeWorker.failToStart = false;
	respond = () => undefined;
	removeStaged.mockReset().mockResolvedValue(undefined);
	sweepStaged.mockReset().mockResolvedValue(undefined);
	vi.stubGlobal("Worker", FakeWorker);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("the notes' worker, from the page", () => {
	it("is a module worker, started once for every call", async () => {
		respond = (request, worker) =>
			worker.answer({ kind: "result", call: request.call, value: { exists: false } });
		const { checkNote } = await load();

		await expect(checkNote("n1")).resolves.toEqual({ exists: false });
		await expect(checkNote("n2")).resolves.toEqual({ exists: false });

		expect(FakeWorker.started).toHaveLength(1);
		expect(FakeWorker.started[0]?.options).toEqual({ type: "module" });
		expect(String(FakeWorker.started[0]?.url)).toMatch(/notes\.worker\.ts/);
	});

	it("creates a note, passing its progress on", async () => {
		const requests: Request[] = [];
		const info = { phase: "uploading", phaseProgress: 0.5, overallProgress: 0.6 } as const;
		respond = (request, worker) => {
			requests.push(request);
			worker.answer({ kind: "progress", call: request.call, info });
			worker.answer({ kind: "result", call: request.call, value: { id: "n1" } });
		};
		const onProgress = vi.fn();
		const { createNote } = await load();

		await expect(createNote({ text: "hi" }, onProgress)).resolves.toEqual({ id: "n1" });
		expect(requests).toEqual([{ kind: "create", call: 1, options: { text: "hi" } }]);
		expect(onProgress).toHaveBeenCalledWith(info);
	});

	it("deletes a note, with or without a proof of work", async () => {
		const requests: Request[] = [];
		respond = (request, worker) => {
			requests.push(request);
			worker.answer({ kind: "result", call: request.call, value: undefined });
		};
		const { deleteNote } = await load();

		await deleteNote("n1", "t", "c");
		await deleteNote("n1", "t");

		expect(requests).toEqual([
			{ kind: "delete", call: 1, id: "n1", deleteToken: "t", capToken: "c" },
			{ kind: "delete", call: 2, id: "n1", deleteToken: "t" },
		]);
	});

	it("rejects with the error the worker sent, of its class", async () => {
		respond = (request, worker) =>
			worker.answer({
				kind: "error",
				call: request.call,
				error: { name: "SecretDecryptionError", message: "nope" },
			});
		const { checkNote, SecretDecryptionError } = await load();

		await expect(checkNote("n1")).rejects.toBeInstanceOf(SecretDecryptionError);
	});

	it("ignores answers to no call", async () => {
		respond = (request, worker) => {
			worker.answer({ kind: "result", call: 99, value: "stray" });
			worker.answer({ kind: "progress", call: 99, info: {} as never });
			worker.answer({ kind: "ready" });
			worker.answer({ kind: "result", call: request.call, value: "mine" });
		};
		const { checkNote } = await load();

		await expect(checkNote("n1")).resolves.toBe("mine");
	});

	it("fails a call when the worker does not start, and starts one anew on the next", async () => {
		FakeWorker.failToStart = true;
		const { checkNote } = await load();

		await expect(checkNote("n1")).rejects.toThrow("The worker did not start");
		expect(FakeWorker.started[0]?.terminate).toHaveBeenCalledOnce();

		FakeWorker.failToStart = false;
		respond = (request, worker) => worker.answer({ kind: "result", call: request.call, value: 1 });
		await expect(checkNote("n1")).resolves.toBe(1);
		expect(FakeWorker.started).toHaveLength(2);
	});

	it("fails the calls under way when the worker stops", async () => {
		respond = (_request, worker) => worker.dispatchEvent(new Event("error"));
		const { checkNote } = await load();

		await expect(checkNote("n1")).rejects.toThrow("The worker stopped");
		expect(FakeWorker.started[0]?.terminate).not.toHaveBeenCalled();
	});
});

describe("reading a note, from the page", () => {
	const file = { name: "a.png", type: "image/png", size: 3, data: new Blob(["abc"]) };

	it("holds the read's lock until the note is closed, which deletes its files", async () => {
		const { held, locks } = fakeLocks();
		vi.stubGlobal("navigator", { locks });
		const requests: Request[] = [];
		respond = (request, worker) => {
			requests.push(request);
			worker.answer({ kind: "result", call: request.call, value: { text: "t", files: [file] } });
		};
		const { readNote } = await load();

		const note = await readNote("n1", "1.k", { password: "pw", chunked: true });

		const [request] = requests as [Extract<Request, { kind: "read" }>];
		expect(request).toEqual({
			kind: "read",
			call: 1,
			id: "n1",
			keyFragment: "1.k",
			password: "pw",
			chunked: true,
			readId: expect.stringMatching(/^[0-9a-f]{32}$/),
		});
		expect(note).toMatchObject({ text: "t", files: [file] });
		expect([...held]).toEqual([`secret-read:${request.readId}`]);
		expect(sweepStaged).toHaveBeenCalledOnce();

		await note.close();
		expect(removeStaged).toHaveBeenCalledWith(request.readId);
		await vi.waitFor(() => expect(held.size).toBe(0));
	});

	it("deletes the files of a read that failed, and lets its lock go", async () => {
		const { held, locks } = fakeLocks();
		vi.stubGlobal("navigator", { locks });
		respond = (request, worker) =>
			worker.answer({
				kind: "error",
				call: request.call,
				error: { name: "SecretDecryptionError", message: "nope" },
			});
		const { readNote, SecretDecryptionError } = await load();

		await expect(readNote("n1", "1.k")).rejects.toBeInstanceOf(SecretDecryptionError);

		expect(removeStaged).toHaveBeenCalledOnce();
		await vi.waitFor(() => expect(held.size).toBe(0));
	});

	it("reads without a password or a hint, and without locks where there are none", async () => {
		vi.stubGlobal("navigator", {});
		const requests: Request[] = [];
		respond = (request, worker) => {
			requests.push(request);
			worker.answer({ kind: "result", call: request.call, value: { files: [] } });
		};
		const { readNote } = await load();

		const note = await readNote("n1", "1.k");
		await note.close();

		expect(requests[0]).not.toHaveProperty("password");
		expect(requests[0]).not.toHaveProperty("chunked");
		expect(removeStaged).toHaveBeenCalledOnce();
	});

	it("reads on when the lock is refused, and when the sweep fails", async () => {
		vi.stubGlobal("navigator", {
			locks: { request: vi.fn(() => Promise.reject(new DOMException("no", "SecurityError"))) },
		});
		sweepStaged.mockRejectedValue(new Error("sweep failed"));
		respond = (request, worker) =>
			worker.answer({ kind: "result", call: request.call, value: { files: [] } });
		const { readNote } = await load();

		await expect(readNote("n1", "1.k")).resolves.toMatchObject({ files: [] });
	});
});

import { SecretApiError } from "@largerio/secret-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Answer, Request } from "../protocol.js";

const sdk = {
	checkNote: vi.fn(),
	deleteNote: vi.fn(),
	createNote: vi.fn(),
	readNoteInto: vi.fn(),
};
/** `SecretClient.create`, which loads the crypto; and each client made with `new`. */
const create = vi.fn();
const constructed = vi.fn();
const staging = { openFile: vi.fn(), files: vi.fn() };
const openStaging = vi.fn();

vi.mock("@largerio/secret-sdk", async (importOriginal) => ({
	...(await importOriginal<typeof import("@largerio/secret-sdk")>()),
	SecretClient: class {
		static create = () => create();
		constructor() {
			constructed();
			// biome-ignore lint/correctness/noConstructorReturn: the fake client is this object.
			return sdk;
		}
	},
}));
vi.mock("../staging.js", () => ({ openStaging: (readId: string) => openStaging(readId) }));

/** Runs a request in a fresh worker, returning everything it posted. */
async function answersTo(...requests: Request[]): Promise<Answer[]> {
	const { handle } = await import("../worker.js");
	const answers: Answer[] = [];
	for (const request of requests) {
		await handle(request, (answer) => answers.push(answer));
	}
	return answers;
}

beforeEach(() => {
	vi.resetModules();
	for (const mock of [
		...Object.values(sdk),
		create,
		constructed,
		openStaging,
		...Object.values(staging),
	]) {
		mock.mockReset();
	}
	create.mockResolvedValue(sdk);
	openStaging.mockResolvedValue(staging);
});

describe("the worker", () => {
	it("checks a note, without loading the crypto", async () => {
		sdk.checkNote.mockResolvedValue({ exists: false });

		expect(await answersTo({ kind: "check", call: 1, id: "n1" })).toEqual([
			{ kind: "result", call: 1, value: { exists: false } },
		]);
		expect(sdk.checkNote).toHaveBeenCalledWith("n1");
		expect(create).not.toHaveBeenCalled();
	});

	it("deletes a note with its token and its proof of work, without loading the crypto", async () => {
		sdk.deleteNote.mockResolvedValue(undefined);

		await answersTo({ kind: "delete", call: 2, id: "n1", deleteToken: "t", capToken: "c" });

		expect(sdk.deleteNote).toHaveBeenCalledWith("n1", "t", "c");
		expect(create).not.toHaveBeenCalled();
	});

	it("loads the crypto when asked to prepare, and does nothing else", async () => {
		expect(await answersTo({ kind: "prepare", call: 1 })).toEqual([
			{ kind: "result", call: 1, value: undefined },
		]);
		expect(create).toHaveBeenCalledOnce();
		for (const method of Object.values(sdk)) expect(method).not.toHaveBeenCalled();
	});

	it("answers a crypto that did not load with its error", async () => {
		create.mockRejectedValueOnce(new Error("wasm init failed"));

		expect(await answersTo({ kind: "prepare", call: 1 })).toEqual([
			{ kind: "error", call: 1, error: { name: "Error", message: "wasm init failed" } },
		]);
	});

	it("creates a note, reporting its progress", async () => {
		const result = { id: "n1", keyFragment: "1.k", deleteToken: "t", expiresAt: "2099" };
		sdk.createNote.mockImplementation(async (options) => {
			options.onProgress({ phase: "uploading", phaseProgress: 0.5, overallProgress: 0.6 });
			return result;
		});
		const data = new File(["x"], "a.txt");

		const answers = await answersTo({
			kind: "create",
			call: 3,
			options: { text: "hi", files: [{ name: "a.txt", type: "text/plain", data }] },
		});

		expect(sdk.createNote).toHaveBeenCalledWith(
			expect.objectContaining({ text: "hi", files: [{ name: "a.txt", type: "text/plain", data }] }),
		);
		expect(answers).toEqual([
			{
				kind: "progress",
				call: 3,
				info: { phase: "uploading", phaseProgress: 0.5, overallProgress: 0.6 },
			},
			{ kind: "result", call: 3, value: result },
		]);
	});

	it("reads a note into its staging, handing its files back as what was staged", async () => {
		const blob = new Blob(["bytes"], { type: "image/png" });
		staging.files.mockResolvedValue([blob]);
		sdk.readNoteInto.mockResolvedValue({
			text: "t",
			contentMode: "markdown",
			files: [{ name: "a.png", type: "image/png", size: 5 }],
			createdAt: "2024",
			expiresAt: "2099",
			fileCount: 1,
		});

		const answers = await answersTo({
			kind: "read",
			call: 4,
			id: "n1",
			keyFragment: "1.k",
			password: "pw",
			chunked: false,
			readId: "r1",
		});

		expect(openStaging).toHaveBeenCalledWith("r1");
		expect(sdk.readNoteInto).toHaveBeenCalledWith("n1", "1.k", {
			password: "pw",
			chunked: false,
			onProgress: expect.any(Function),
			openFile: staging.openFile,
		});
		expect(answers).toEqual([
			{
				kind: "result",
				call: 4,
				value: {
					text: "t",
					contentMode: "markdown",
					files: [{ name: "a.png", type: "image/png", size: 5, data: blob }],
				},
			},
		]);
	});

	it("reads a note without a password or a hint, and without text", async () => {
		staging.files.mockResolvedValue([]);
		sdk.readNoteInto.mockResolvedValue({ files: [] });

		const [answer] = await answersTo({
			kind: "read",
			call: 5,
			id: "n1",
			keyFragment: "1.k",
			readId: "r1",
		});

		expect(sdk.readNoteInto.mock.calls[0]?.[2]).not.toHaveProperty("password");
		expect(sdk.readNoteInto.mock.calls[0]?.[2]).not.toHaveProperty("chunked");
		expect(answer).toEqual({ kind: "result", call: 5, value: { files: [] } });
	});

	it("answers a failure with the error, as it can cross to the page", async () => {
		sdk.checkNote.mockRejectedValue(new SecretApiError("Gone", 404, { code: "note_not_found" }));

		expect(await answersTo({ kind: "check", call: 6, id: "n1" })).toEqual([
			{
				kind: "error",
				call: 6,
				error: { name: "SecretApiError", message: "Gone", status: 404, code: "note_not_found" },
			},
		]);
	});

	it("serves every request with one client", async () => {
		sdk.checkNote.mockResolvedValue({ exists: false });
		sdk.deleteNote.mockResolvedValue(undefined);
		sdk.createNote.mockResolvedValue({ id: "n1" });

		const answers = await answersTo(
			{ kind: "check", call: 7, id: "n1" },
			{ kind: "prepare", call: 8 },
			{ kind: "create", call: 9, options: { text: "hi" } },
			{ kind: "delete", call: 10, id: "n1", deleteToken: "t" },
		);

		expect(answers.map((answer) => answer.kind)).toEqual(["result", "result", "result", "result"]);
		expect(constructed).toHaveBeenCalledOnce();
	});
});

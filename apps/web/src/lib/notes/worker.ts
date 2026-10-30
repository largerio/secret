import { type ProgressInfo, SecretClient } from "@largerio/secret-sdk";
import type { Answer, ReadResult, Request } from "#lib/notes/protocol.js";
import { sentError } from "#lib/notes/protocol.js";
import { openStaging } from "#lib/notes/staging.js";

let client: Promise<SecretClient> | undefined;

function getClient(): Promise<SecretClient> {
	client ??= SecretClient.create().catch((err: unknown) => {
		client = undefined;
		throw err;
	});
	return client;
}

/**
 * Answers a page's request, in the worker that encrypts and decrypts notes,
 * off the page's thread: with its result or its error, every time.
 */
export async function handle(request: Request, post: (answer: Answer) => void): Promise<void> {
	const { call } = request;
	const onProgress = (info: ProgressInfo) => post({ kind: "progress", call, info });
	try {
		const value = await run(await getClient(), request, onProgress);
		post({ kind: "result", call, value });
	} catch (err) {
		post({ kind: "error", call, error: sentError(err) });
	}
}

async function run(
	sdk: SecretClient,
	request: Request,
	onProgress: (info: ProgressInfo) => void,
): Promise<unknown> {
	switch (request.kind) {
		case "check":
			return sdk.checkNote(request.id);
		case "delete":
			return sdk.deleteNote(request.id, request.deleteToken, request.capToken);
		case "create":
			return sdk.createNote({ ...request.options, onProgress });
		case "read":
			return read(sdk, request, onProgress);
	}
}

/** Reads a note into its staging, its files handed back as Blobs of what was staged. */
async function read(
	sdk: SecretClient,
	request: Extract<Request, { kind: "read" }>,
	onProgress: (info: ProgressInfo) => void,
): Promise<ReadResult> {
	const staging = await openStaging(request.readId);
	const note = await sdk.readNoteInto(request.id, request.keyFragment, {
		...(request.password ? { password: request.password } : {}),
		...(request.chunked !== undefined ? { chunked: request.chunked } : {}),
		onProgress,
		openFile: staging.openFile,
	});
	const blobs = await staging.files();
	return {
		...(note.text !== undefined ? { text: note.text } : {}),
		...(note.contentMode ? { contentMode: note.contentMode } : {}),
		files: note.files.map((file, index) => ({ ...file, data: blobs[index] as Blob })),
	};
}

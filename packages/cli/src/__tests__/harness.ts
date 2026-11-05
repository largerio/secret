import type { ExistingNoteInfo, NoteFileInfo, SecretClientConfig } from "@largerio/secret-sdk";
import { expect, vi } from "vitest";
import { CliError } from "../errors.js";
import type { OutputDirectory, WrittenFile } from "../files.js";
import type { ProofOfWorkOptions } from "../pow.js";
import { run } from "../run.js";
import type { InputStream, Io, NotesClient, OutputStream, Terminal } from "../types.js";

export const ORIGIN = "https://secret.example";
export const NOTE_ID = "aBcDeFgHiJkL";
/** A format 1 fragment: `1.` then 43 base64url characters. */
export const KEY = `1.${"K".repeat(42)}A`;
export const LINK = `${ORIGIN}/note/${NOTE_ID}#${KEY}`;
export const DELETE_TOKEN = "d".repeat(32);
export const CREATED_AT = "2026-11-05T12:00:00.000Z";
export const EXPIRES_AT = "2026-11-06T12:00:00.000Z";
export const CAP_TOKEN = "cap-token";

export const LIMITS = {
	maxFileSize: 10_485_760,
	maxFilesPerNote: 10,
	maxExpiry: 2_592_000,
	chunkSize: 65_536,
	maxChunkedFileSize: 1_048_576,
};

/** The CliError `attempt` returns, throws or rejects with: anything else fails the test. */
export async function cliErrorOf(attempt: () => unknown): Promise<CliError> {
	let outcome: unknown;
	try {
		outcome = await attempt();
	} catch (err) {
		outcome = err;
	}
	expect(outcome).toBeInstanceOf(CliError);
	return outcome as CliError;
}

/** `value` without `keys`: what an older instance answers, or an io without a default. */
export function without<T extends object, K extends keyof T>(value: T, ...keys: K[]): Omit<T, K> {
	const dropped = new Set<PropertyKey>(keys);
	return Object.fromEntries(Object.entries(value).filter(([key]) => !dropped.has(key))) as Omit<
		T,
		K
	>;
}

/** A stream that keeps what is written to it. */
export class Output implements OutputStream {
	text = "";

	constructor(readonly isTTY = false) {}

	write(text: string): void {
		this.text += text;
	}
}

/** Stdin, from its chunks. */
export function input(chunks: ReadonlyArray<string | Uint8Array>, isTTY = false): InputStream {
	return {
		isTTY,
		async *[Symbol.asyncIterator]() {
			for (const chunk of chunks) {
				yield typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
			}
		},
	};
}

export function existingNote(overrides: Partial<ExistingNoteInfo> = {}): ExistingNoteInfo {
	return {
		exists: true,
		hasPassword: false,
		fileCount: 0,
		expiresAt: EXPIRES_AT,
		maxReads: 1,
		readCount: 0,
		chunked: false,
		envelope: "AAAA",
		...overrides,
	};
}

/** A client of the SDK's shape, whose every call is a mock. */
export function fakeClient() {
	return {
		buildShareUrl: vi.fn<NotesClient["buildShareUrl"]>(
			(id, keyFragment) => `${ORIGIN}/note/${id}#${keyFragment}`,
		),
		checkNote: vi.fn<NotesClient["checkNote"]>(async () => existingNote()),
		createNote: vi.fn<NotesClient["createNote"]>(async () => ({
			id: NOTE_ID,
			expiresAt: EXPIRES_AT,
			deleteToken: DELETE_TOKEN,
			keyFragment: KEY,
		})),
		deleteNote: vi.fn<NotesClient["deleteNote"]>(async () => undefined),
		readNoteInto: vi.fn<NotesClient["readNoteInto"]>(async () => ({
			text: "hello",
			files: [],
			createdAt: CREATED_AT,
			expiresAt: EXPIRES_AT,
			fileCount: 0,
		})),
	} satisfies NotesClient;
}

/** A terminal that answers each prompt in turn. */
export function fakeTerminal(answers: ReadonlyArray<string>) {
	const left = [...answers];
	return {
		readHidden: vi.fn<Terminal["readHidden"]>(async () => {
			const answer = left.shift();
			if (answer === undefined) {
				throw new Error("no answer left");
			}
			return answer;
		}),
		write: vi.fn<Terminal["write"]>(),
		close: vi.fn<Terminal["close"]>(),
	} satisfies Terminal;
}

/** An output directory that keeps what is written in memory, under `dir`. */
export function fakeDirectory(dir: string) {
	const written: WrittenFile[] = [];
	const contents = new Map<string, string>();
	return {
		open: vi.fn(async (file: NoteFileInfo, _index: number) => {
			let text = "";
			return new WritableStream<Uint8Array>({
				write: (chunk) => {
					text += new TextDecoder().decode(chunk);
				},
				close: () => {
					const path = `${dir}/${file.name}`;
					contents.set(path, text);
					written.push({ name: file.name, path, type: file.type, size: file.size });
				},
			});
		}),
		written,
		contents,
		discard: vi.fn<OutputDirectory["discard"]>(async () => undefined),
	} satisfies OutputDirectory & { contents: Map<string, string> };
}

/** An instance's answers: its configuration, and a 404 for anything else. */
export function instanceFetch(limits: unknown = LIMITS) {
	return vi.fn<typeof fetch>(async (input) => {
		const url = String(input);
		if (url.endsWith("/api/v1/config")) {
			return Response.json(limits);
		}
		return new Response("not found", { status: 404 });
	});
}

export interface Setup {
	readonly stdin?: InputStream;
	readonly stdoutIsTTY?: boolean;
	readonly stderrIsTTY?: boolean;
	readonly env?: Record<string, string>;
	readonly cwd?: string;
	readonly fetch?: typeof fetch;
	readonly terminal?: Terminal;
	readonly signal?: AbortSignal;
}

/** Everything a command touches, faked, and `run` over it. */
export function harness(setup: Setup = {}) {
	const stdout = new Output(setup.stdoutIsTTY);
	const stderr = new Output(setup.stderrIsTTY);
	const client = fakeClient();
	const configs: SecretClientConfig[] = [];
	const directories: Array<ReturnType<typeof fakeDirectory>> = [];
	const fetch = setup.fetch ?? instanceFetch();
	const pow = vi.fn(async (_baseUrl: string, options: ProofOfWorkOptions) => {
		options.onProgress?.(1, 2);
		options.onProgress?.(2, 2);
		return CAP_TOKEN;
	});
	const openTerminal = vi.fn(() => setup.terminal);
	const io: Io = {
		stdin: setup.stdin ?? input([]),
		stdout,
		stderr,
		env: setup.env ?? {},
		cwd: setup.cwd ?? "/work",
		fetch,
		signal: setup.signal ?? new AbortController().signal,
		openTerminal,
		createClient: async (config) => {
			configs.push(config);
			return client;
		},
		solveProofOfWork: pow,
		createOutputDirectory: (dir) => {
			const directory = fakeDirectory(dir);
			directories.push(directory);
			return directory;
		},
	};
	return {
		io,
		stdout,
		stderr,
		client,
		configs,
		directories,
		fetch,
		pow,
		openTerminal,
		run: (...argv: string[]) => run(argv, io),
	};
}

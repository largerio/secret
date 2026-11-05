import type { SecretClient, SecretClientConfig } from "@largerio/secret-sdk";
import type { createOutputDirectory } from "./files.js";
import type { solveProofOfWork } from "./pow.js";

/** What the command reads: stdin, the note's text when it is piped in. */
export interface InputStream extends AsyncIterable<Uint8Array> {
	readonly isTTY: boolean;
}

/** What the command writes text to: stdout or stderr. */
export interface OutputStream {
	readonly isTTY: boolean;
	write(text: string): void;
}

/**
 * The controlling terminal, where a password is asked: never stdin, which may
 * carry the note's text.
 */
export interface Terminal {
	/**
	 * Writes `prompt`, then reads a line without echoing it. Ctrl-C rejects with
	 * an interrupted `CliError`, the end of input with nothing typed with a usage
	 * one.
	 */
	readHidden(prompt: string, signal: AbortSignal): Promise<string>;
	write(text: string): void;
	close(): void;
}

/** What the commands use of the SDK's client. */
export type NotesClient = Pick<
	SecretClient,
	"buildShareUrl" | "checkNote" | "createNote" | "deleteNote" | "readNoteInto"
>;

/**
 * Everything the command line touches outside its own code, so that it runs
 * without a real terminal or network.
 *
 * The first block is required. The second has defaults, which are the real
 * thing: `SecretClient.create` from the SDK (loaded on first use), the
 * instance's proof of work, the output directory of `files.ts`, and no
 * terminal at all, so that a program embedding `run` never has a password
 * asked on its user's terminal unless it passes `openControllingTerminal`.
 * An integration test can therefore give only the streams and `fetch` and
 * run the real client against a real instance.
 */
export interface Io {
	readonly stdin: InputStream;
	readonly stdout: OutputStream;
	readonly stderr: OutputStream;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** Where relative paths start: the files to send, `--out`, `--password-file`. */
	readonly cwd: string;
	/** Every request goes through it: the instance's configuration, the SDK's, the proof of work's. */
	readonly fetch: typeof fetch;
	/** Aborted on Ctrl-C, SIGTERM or SIGHUP: the command stops and removes partial files. */
	readonly signal: AbortSignal;

	/** Opens the controlling terminal, or answers undefined when there is none. Default: none. */
	readonly openTerminal?: () => Terminal | undefined;
	/** Builds the SDK client of an instance. Default: `SecretClient.create`. */
	readonly createClient?: (config: SecretClientConfig) => Promise<NotesClient>;
	/** Default: `solveProofOfWork` of `pow.ts`. */
	readonly solveProofOfWork?: typeof solveProofOfWork;
	/** Default: `createOutputDirectory` of `files.ts`. */
	readonly createOutputDirectory?: typeof createOutputDirectory;
}

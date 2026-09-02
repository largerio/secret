import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import type { Readable } from "node:stream";

/**
 * Everything the commands touch outside the SDK, so the tests can drive them
 * with an in-memory implementation and assert on exact output.
 */
export interface Io {
	readonly env: Readonly<Record<string, string | undefined>>;
	/** True when stdin is a terminal — nothing is being piped in. */
	readonly stdinIsTTY: boolean;
	/** True when stdout is a terminal: output is for a person, not a pipe. */
	readonly stdoutIsTTY: boolean;
	readStdin(): Promise<Uint8Array>;
	writeOut(text: string): void;
	writeErr(text: string): void;
	readFile(path: string): Promise<Uint8Array>;
	fileExists(path: string): Promise<boolean>;
	writeFile(path: string, data: Uint8Array): Promise<void>;
	ensureDir(path: string): Promise<void>;
}

interface OutputStream {
	readonly isTTY?: boolean | undefined;
	write(chunk: string): unknown;
}

export interface NodeIoStreams {
	readonly stdin: Readable & { readonly isTTY?: boolean | undefined };
	readonly stdout: OutputStream;
	readonly stderr: OutputStream;
	readonly env: Readonly<Record<string, string | undefined>>;
}

export function createNodeIo(streams: NodeIoStreams): Io {
	return {
		env: streams.env,
		stdinIsTTY: streams.stdin.isTTY === true,
		stdoutIsTTY: streams.stdout.isTTY === true,
		async readStdin() {
			const chunks: Buffer[] = [];
			for await (const chunk of streams.stdin) {
				chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
			}
			return new Uint8Array(Buffer.concat(chunks));
		},
		writeOut(text) {
			streams.stdout.write(text);
		},
		writeErr(text) {
			streams.stderr.write(text);
		},
		async readFile(path) {
			return new Uint8Array(await readFile(path));
		},
		async fileExists(path) {
			try {
				await access(path);
				return true;
			} catch {
				return false;
			}
		},
		async writeFile(path, data) {
			await writeFile(path, data);
		},
		async ensureDir(path) {
			await mkdir(path, { recursive: true });
		},
	};
}

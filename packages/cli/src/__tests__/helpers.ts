import { SecretClient } from "@largerio/secret-sdk";
import { vi } from "vitest";
import type { Io } from "../io.js";

export interface FakeIo extends Io {
	readonly out: string[];
	readonly err: string[];
	readonly written: Map<string, Uint8Array>;
	readonly dirs: string[];
}

export interface FakeIoOptions {
	readonly env?: Record<string, string | undefined>;
	readonly stdin?: string | Uint8Array;
	readonly stdinIsTTY?: boolean;
	readonly stdoutIsTTY?: boolean;
	readonly files?: Record<string, Uint8Array>;
	/** Paths `fileExists` reports as taken. */
	readonly existing?: readonly string[];
}

/** An in-memory `Io`: records every write, serves canned stdin and files. */
export function createFakeIo(options: FakeIoOptions = {}): FakeIo {
	const out: string[] = [];
	const err: string[] = [];
	const written = new Map<string, Uint8Array>();
	const existing = new Set(options.existing ?? []);
	const dirs: string[] = [];
	const stdin =
		typeof options.stdin === "string"
			? new TextEncoder().encode(options.stdin)
			: (options.stdin ?? new Uint8Array());
	const files = options.files ?? {};
	return {
		env: options.env ?? {},
		stdinIsTTY: options.stdinIsTTY ?? true,
		stdoutIsTTY: options.stdoutIsTTY ?? false,
		out,
		err,
		written,
		dirs,
		readStdin: () => Promise.resolve(stdin),
		writeOut: (text) => {
			out.push(text);
		},
		writeErr: (text) => {
			err.push(text);
		},
		readFile: (path) => {
			const data = files[path];
			if (data === undefined) {
				return Promise.reject(new Error(`ENOENT: no such file or directory, open '${path}'`));
			}
			return Promise.resolve(data);
		},
		fileExists: (path) => Promise.resolve(existing.has(path) || written.has(path)),
		writeFile: (path, data) => {
			written.set(path, data);
			return Promise.resolve();
		},
		ensureDir: (path) => {
			dirs.push(path);
			return Promise.resolve();
		},
	};
}

export interface FakeClient {
	readonly createNote: ReturnType<typeof vi.fn>;
	readonly checkNote: ReturnType<typeof vi.fn>;
	readonly readNote: ReturnType<typeof vi.fn>;
	readonly deleteNote: ReturnType<typeof vi.fn>;
	readonly buildShareUrl: ReturnType<typeof vi.fn>;
}

/**
 * Stub `SecretClient.create` so no command ever initialises libsodium or
 * touches the network. `parseShareUrl` (static, pure) stays real.
 */
export function stubClient(): { client: FakeClient; create: ReturnType<typeof vi.fn> } {
	const client: FakeClient = {
		createNote: vi.fn(),
		checkNote: vi.fn(),
		readNote: vi.fn(),
		deleteNote: vi.fn(),
		buildShareUrl: vi.fn(
			(id: string, key: string) => `https://secret.example.com/note/${id}#${key}`,
		),
	};
	const create = vi
		.spyOn(SecretClient, "create")
		.mockResolvedValue(client as unknown as SecretClient);
	return { client, create };
}

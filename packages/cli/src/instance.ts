import {
	SecretClient,
	type SecretClientConfig,
	type SecretValidationError,
} from "@largerio/secret-sdk";
import { CliError, EXIT } from "./errors.js";
import { lowerFirst } from "./options.js";
import { solveProofOfWork } from "./pow.js";
import type { Screen } from "./terminal.js";
import type { Io, NotesClient } from "./types.js";

/** An instance, as the command talks to it and names it. */
export interface Instance {
	/** Where its API is: its origin, and for a link the path before `/note/`. */
	readonly baseUrl: string;
	/** What the messages name it by: never a link, which holds a key. */
	readonly origin: string;
}

/** A note's link, split. */
export interface NoteLink extends Instance {
	readonly id: string;
	readonly keyFragment: string;
}

function withoutTrailingSlashes(path: string): string {
	let end = path.length;
	while (end > 0 && path[end - 1] === "/") {
		end--;
	}
	return path.slice(0, end);
}

function isHttp(url: URL): boolean {
	return url.protocol === "http:" || url.protocol === "https:";
}

/** The instance `--instance` or `SECRET_INSTANCE` names. */
export function instanceOf(value: string): Instance {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new CliError("the instance must be an http or https URL", EXIT.usage);
	}
	if (!isHttp(url)) {
		throw new CliError("the instance must be an http or https URL", EXIT.usage);
	}
	return { baseUrl: url.origin + withoutTrailingSlashes(url.pathname), origin: url.origin };
}

/**
 * A note's link: its instance (the origin and the path before `/note/`), the
 * note's id and its key. No message repeats the link.
 */
export function linkOf(link: string): NoteLink {
	let url: URL;
	try {
		url = new URL(link);
	} catch {
		throw new CliError("this is not a link: give the whole of it, https:// included", EXIT.usage);
	}
	if (!isHttp(url)) {
		throw new CliError("the link must be an http or https URL", EXIT.usage);
	}
	let note: { id: string; keyFragment: string };
	try {
		note = SecretClient.parseShareUrl(link);
	} catch (err) {
		// A SecretValidationError, whose message names what is missing, not the link.
		const message = lowerFirst((err as SecretValidationError).message);
		throw new CliError(`this is not the link of a note: ${message}`, EXIT.usage);
	}
	// The same split as parseShareUrl's, which found a note in it.
	const parts = url.pathname.split("/");
	const prefix = parts.slice(0, parts.indexOf("note")).join("/");
	return { baseUrl: url.origin + prefix, origin: url.origin, ...note };
}

/** What an instance announces at `GET /api/v1/config` (PROTOCOL.md, "Instance limits"). */
export interface Limits {
	readonly maxFilesPerNote: number;
	readonly maxExpiry: number;
	readonly chunkSize: number;
	readonly maxChunkedFileSize: number;
}

const LIMITS: ReadonlyArray<keyof Limits> = [
	"maxFilesPerNote",
	"maxExpiry",
	"chunkSize",
	"maxChunkedFileSize",
];

function limitsOf(body: unknown): Limits | undefined {
	if (typeof body !== "object" || body === null) {
		return undefined;
	}
	const fields = body as Record<string, unknown>;
	const valid = LIMITS.every((name) => {
		const value = fields[name];
		return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
	});
	return valid ? (fields as unknown as Limits) : undefined;
}

/**
 * The instance's limits, read before anything is encrypted or solved: a note
 * it would refuse is refused here, and the SDK's chunks fit its chunk size.
 */
export async function fetchLimits(io: Io, instance: Instance): Promise<Limits> {
	const notAnInstance = (detail: string) =>
		new CliError(`${instance.origin} gave no limits (${detail}): is it a Secret instance?`);
	let body: unknown;
	try {
		const response = await io.fetch(`${instance.baseUrl}/api/v1/config`, {
			headers: { accept: "application/json" },
			signal: io.signal,
		});
		if (!response.ok) {
			throw notAnInstance(`HTTP ${response.status}`);
		}
		body = await response.json().catch(() => undefined);
	} catch (err) {
		if (err instanceof CliError) {
			throw err;
		}
		throw new CliError(`could not reach ${instance.origin}`, EXIT.failure, { cause: err });
	}
	const limits = limitsOf(body);
	if (limits === undefined) {
		throw notAnInstance("not the answer of one");
	}
	return limits;
}

/** The SDK client of an instance, with the key of a write if there is one. */
export function connect(io: Io, instance: Instance, apiKey?: string): Promise<NotesClient> {
	const config: SecretClientConfig = {
		baseUrl: instance.baseUrl,
		fetch: io.fetch,
		...(apiKey === undefined ? {} : { apiKey }),
	};
	return io.createClient === undefined ? SecretClient.create(config) : io.createClient(config);
}

/**
 * A single-use write token, from the instance's proof of work: how a write
 * without an API key is let in, as the browser's are.
 */
export async function proofOfWork(io: Io, instance: Instance, screen: Screen): Promise<string> {
	const solve = io.solveProofOfWork ?? solveProofOfWork;
	try {
		return await solve(instance.baseUrl, {
			fetch: io.fetch,
			signal: io.signal,
			onProgress: (solved, total) => screen.progress(`Proof of work ${solved}/${total}`),
		});
	} catch (err) {
		if (err instanceof CliError) {
			throw err;
		}
		throw new CliError(
			`could not solve the proof of work of ${instance.origin}: set SECRET_API_KEY to write with a key`,
			EXIT.failure,
			{ cause: err },
		);
	} finally {
		screen.done();
	}
}

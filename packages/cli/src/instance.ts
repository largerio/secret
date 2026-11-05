import { NOTE_ID_LENGTH, SecretClient, type SecretClientConfig } from "@largerio/secret-sdk";
import { parseJson, readBodyAtMost, recordOf } from "./answers.js";
import { CliError, EXIT } from "./errors.js";
import { solveProofOfWork } from "./pow.js";
import type { Screen } from "./terminal.js";
import type { Io, NotesClient } from "./types.js";
import { withoutTrailingSlashes } from "./url.js";

/** An instance, as the command talks to it and names it. */
export interface Instance {
	/** Where its API is: its origin, and for a link the path before `/note/`. */
	readonly baseUrl: string;
	/** What the messages name it by: never a link, which holds a key. */
	readonly origin: string;
}

/** A note, as its link names it: its instance and its id. */
export interface NoteAddress extends Instance {
	readonly id: string;
}

/** A note's link, split: where the note is, and its key. */
export interface NoteLink extends NoteAddress {
	readonly keyFragment: string;
}

/** A note's id (PROTOCOL.md, "The link"), which goes into the paths of the requests. */
const NOTE_ID = new RegExp(`^[A-Za-z0-9_-]{${NOTE_ID_LENGTH}}$`);
/** What a format 1 link's fragment starts with, before the key. */
const FORMAT_1_PREFIX = "1.";

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
 * Refuses to send an API key in the clear: over http to another machine,
 * whoever is on the way could read it, then write with it. Over http to this
 * one, as an instance runs in development, the key stays here; and
 * `--allow-http` takes the risk elsewhere.
 */
export function assertKeyStaysPrivate(instance: Instance, allowHttp: boolean): void {
	const url = new URL(instance.origin);
	if (url.protocol === "https:" || allowHttp) {
		return;
	}
	if (isLoopback(url.hostname)) {
		return;
	}
	throw new CliError(
		`the API key would go to ${instance.origin} in the clear: use https, or pass --allow-http`,
		EXIT.usage,
	);
}

/** This machine: `localhost` and the names under it, 127.0.0.0/8 and ::1, as a URL writes them. */
function isLoopback(hostname: string): boolean {
	return (
		hostname === "localhost" ||
		hostname.endsWith(".localhost") ||
		hostname === "[::1]" ||
		/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
	);
}

function urlOf(link: string): URL {
	let url: URL;
	try {
		url = new URL(link);
	} catch {
		throw new CliError("this is not a link: give the whole of it, https:// included", EXIT.usage);
	}
	if (!isHttp(url)) {
		throw new CliError("the link must be an http or https URL", EXIT.usage);
	}
	return url;
}

/**
 * Where a link's note is: its instance, the origin and the path before
 * `/note/`, and its id, which must be one before any request names it: a
 * forged one could make a request another endpoint's, the read that spends.
 * The key, if the link holds one, is left alone. No message repeats the link.
 */
export function noteOf(link: string): NoteAddress {
	return addressOf(urlOf(link));
}

function addressOf(url: URL): NoteAddress {
	// Split as the SDK's parseShareUrl splits it, an id left encoded refused.
	const parts = url.pathname.split("/");
	const index = parts.indexOf("note");
	const id = index === -1 ? undefined : parts[index + 1];
	if (id === undefined || !NOTE_ID.test(id)) {
		throw new CliError("this is not the link of a note", EXIT.usage);
	}
	return { baseUrl: url.origin + parts.slice(0, index).join("/"), origin: url.origin, id };
}

/**
 * A note's link, with its key, which must be one before the note is read: a
 * key cut short, or of a format this version does not know, could only spend
 * a read for nothing.
 */
export function linkOf(link: string): NoteLink {
	const url = urlOf(link);
	const note = addressOf(url);
	const fragment = url.hash.slice(1);
	if (fragment === "") {
		throw new CliError(
			"the link has no key: give the whole of it, quoted, the part after # included",
			EXIT.usage,
		);
	}
	let keyFragment: string;
	try {
		keyFragment = decodeURIComponent(fragment);
	} catch {
		throw damagedLink();
	}
	const key = keyFragment.startsWith(FORMAT_1_PREFIX)
		? keyFragment.slice(FORMAT_1_PREFIX.length)
		: keyFragment;
	if (!isKey(key)) {
		throw damagedLink();
	}
	return { ...note, keyFragment };
}

/** The format a link's key is in, as `linkOf` checked it: 1 after `1.`, 0 for a bare key. */
export function formatOfLink(link: NoteLink): 0 | 1 {
	return link.keyFragment.startsWith(FORMAT_1_PREFIX) ? 1 : 0;
}

/**
 * Whether `text` is a key as PROTOCOL.md writes it ("The link"): 32 bytes in
 * 43 base64url characters, the last one's two spare bits zero. Anything else
 * after `1.`, or another number before the dot, is no key.
 */
function isKey(text: string): boolean {
	return (
		/^[A-Za-z0-9_-]{43}$/.test(text) &&
		Buffer.from(text, "base64url").toString("base64url") === text
	);
}

function damagedLink(): CliError {
	return new CliError("the link is wrong or damaged", EXIT.refused);
}

/** What an instance announces at `GET /api/v1/config` (PROTOCOL.md, "Instance limits"). */
export interface Limits {
	readonly maxFilesPerNote: number;
	readonly maxExpiry: number;
	/** The instance's, at most {@link MAX_CHUNK_SIZE}: the size of the SDK's chunks. */
	readonly chunkSize: number;
	readonly maxChunkedFileSize: number;
}

/** The configuration is a few hundred bytes: anything much longer is no instance's. */
const MAX_CONFIG_BYTES = 64 * 1024;
/**
 * The smallest chunk size taken: smaller, a large note would take a request
 * for every few bytes. An instance is not trusted to ask for a sane one.
 */
const MIN_CHUNK_SIZE = 64 * 1024;
/**
 * The largest chunk size given to the SDK. A writer should take the
 * instance's (PROTOCOL.md, "Format 1", "Upload"), so that its messages look
 * like every other writer's there, and the command does up to this bound.
 * Past it, it takes the bound, which the instance takes as well, a message
 * being at most its chunk size: the SDK holds a message in memory, and sends
 * a note that fits in one whole.
 */
const MAX_CHUNK_SIZE = 64 * 1024 * 1024;

function limitsOf(body: unknown): Limits | undefined {
	const fields = recordOf(body);
	const [maxFilesPerNote, maxExpiry, chunkSize, maxChunkedFileSize] = [
		fields?.["maxFilesPerNote"],
		fields?.["maxExpiry"],
		fields?.["chunkSize"],
		fields?.["maxChunkedFileSize"],
	];
	if (
		!isPositiveInteger(maxFilesPerNote) ||
		!isPositiveInteger(maxExpiry) ||
		!isPositiveInteger(chunkSize) ||
		!isPositiveInteger(maxChunkedFileSize)
	) {
		return undefined;
	}
	if (chunkSize < MIN_CHUNK_SIZE) {
		return undefined;
	}
	return {
		maxFilesPerNote,
		maxExpiry,
		chunkSize: Math.min(chunkSize, MAX_CHUNK_SIZE),
		maxChunkedFileSize,
	};
}

function isPositiveInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
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
		const text = await readBodyAtMost(response, MAX_CONFIG_BYTES);
		body = text === undefined ? undefined : parseJson(text);
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

import { SecretClient } from "@largerio/secret-sdk";
import { UsageError } from "./errors.js";

export const ENV_SERVER_URL = "SECRET_SERVER_URL";
export const ENV_API_KEY = "SECRET_API_KEY";

export interface ConnectionOptions {
	readonly server?: string;
	readonly apiKey?: string;
}

export interface Connection {
	readonly serverUrl?: string;
	readonly apiKey?: string;
}

/** A note named on the command line: by share URL, plain URL, or bare id. */
export interface NoteRef {
	readonly id: string;
	readonly keyFragment?: string;
	/** The instance the URL points at, when it is absolute. */
	readonly serverUrl?: string;
}

/** A share URL: the key fragment is present, so the note can be decrypted. */
export interface ShareRef extends NoteRef {
	readonly keyFragment: string;
}

function normalizeServerUrl(raw: string, source: string): string {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new UsageError(`Invalid server URL from ${source}: '${raw}'`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new UsageError(`Invalid server URL from ${source}: '${raw}' (expected http or https)`);
	}
	// The SDK appends `/api/v1` itself; a trailing slash would double it.
	return parsed.href.replace(/\/+$/, "");
}

/**
 * Flags win over the environment, which wins over the instance a note URL
 * points at. Only writes need a key: a missing one is not an error here — the
 * command that needs it asks with {@link requireApiKey}.
 */
export function resolveConnection(
	options: ConnectionOptions,
	env: Readonly<Record<string, string | undefined>>,
	noteServerUrl?: string,
): Connection {
	const flagServer = options.server;
	const envServer = env[ENV_SERVER_URL];
	let serverUrl: string | undefined;
	if (flagServer !== undefined) {
		serverUrl = normalizeServerUrl(flagServer, "--server");
	} else if (envServer !== undefined && envServer !== "") {
		serverUrl = normalizeServerUrl(envServer, ENV_SERVER_URL);
	} else if (noteServerUrl !== undefined) {
		serverUrl = noteServerUrl;
	}

	const apiKey = options.apiKey ?? env[ENV_API_KEY];
	return {
		...(serverUrl !== undefined ? { serverUrl } : {}),
		...(apiKey !== undefined && apiKey !== "" ? { apiKey } : {}),
	};
}

export function requireServer(connection: Connection): string {
	if (connection.serverUrl === undefined) {
		throw new UsageError(
			`No Secret instance configured: pass --server <url> or set ${ENV_SERVER_URL}`,
		);
	}
	return connection.serverUrl;
}

/**
 * Writes need an API key. The Proof-of-Work alternative the web UI uses is
 * a browser path (it solves a challenge in a widget); there is no CLI
 * equivalent, and reads never needed either.
 */
export function requireApiKey(connection: Connection): string {
	if (connection.apiKey === undefined) {
		throw new UsageError(
			`This command writes to the instance and needs an API key: pass --api-key <key> or set ${ENV_API_KEY}`,
		);
	}
	return connection.apiKey;
}

const NOTE_PATH = "/note/";

function invalidUrl(input: string): UsageError {
	return new UsageError(`Invalid note URL: '${input}' (expected …/note/<id>)`);
}

/**
 * Accept what a person is likely to paste: the full share URL (`…/note/<id>#<key>`),
 * the same URL without its fragment, or just the id. The key is only required
 * when the command decrypts. Malformed share URLs surface as the SDK's
 * SecretValidationError, which the entry point reports as a usage error.
 */
export function parseNoteRef(input: string, options: { readonly needKey: true }): ShareRef;
export function parseNoteRef(input: string, options: { readonly needKey: false }): NoteRef;
export function parseNoteRef(input: string, options: { readonly needKey: boolean }): NoteRef {
	const trimmed = input.trim();
	const hasFragment = trimmed.includes("#");
	if (options.needKey && !hasFragment) {
		throw new UsageError(
			"The share URL carries no #key fragment: without it the note cannot be decrypted (the link may have been truncated)",
		);
	}

	if (!/^https?:\/\//i.test(trimmed)) {
		if (hasFragment) {
			// A relative share URL, as the SDK builds under its default config.
			const { id, keyFragment } = SecretClient.parseShareUrl(trimmed);
			return { id, keyFragment };
		}
		if (trimmed === "" || trimmed.includes("/")) {
			throw new UsageError(`Invalid note URL or id: '${input}'`);
		}
		return { id: trimmed };
	}

	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw invalidUrl(input);
	}
	const noteIndex = url.pathname.indexOf(NOTE_PATH);
	if (noteIndex === -1) {
		throw invalidUrl(input);
	}
	// The web UI serves notes at <base>/note/<id>; whatever precedes that is
	// the instance, including a sub-path it may be mounted under.
	const serverUrl = `${url.origin}${url.pathname.slice(0, noteIndex)}`;

	if (hasFragment) {
		const { id, keyFragment } = SecretClient.parseShareUrl(trimmed);
		return { id, keyFragment, serverUrl };
	}

	const rest = url.pathname.slice(noteIndex + NOTE_PATH.length);
	const slash = rest.indexOf("/");
	const id = slash === -1 ? rest : rest.slice(0, slash);
	if (id === "") {
		throw invalidUrl(input);
	}
	return { id: decodeURIComponent(id), serverUrl };
}

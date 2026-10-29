import type { AcceptedEnvelope } from "@largerio/secret-shared";
import type {
	ChunkedFormat0Opening,
	ChunkedOpening,
	Format0Opening,
	Format1Opening,
	NoteSettings,
	ReadVerifiers,
	SealedVerifier,
	StoredSettings,
} from "./types.js";

/**
 * What a format 1 write declares: its envelope, which says it all, and beside
 * it the verifiers of the proofs its readers will send.
 */
export interface Format1Request {
	readonly envelope: AcceptedEnvelope;
	readonly linkVerifier: Uint8Array;
	readonly passwordVerifier?: Uint8Array | undefined;
}

/** What a format 0 write declares, field by field. */
export interface Format0Request {
	readonly clientNonce: string;
	readonly hasPassword: boolean;
	readonly expiresIn: number;
	readonly maxReads: number;
	readonly fileCount: number;
	readonly salt?: string | undefined;
}

/** A chunked format 0 note also declares its secretstream header. */
export interface ChunkedFormat0Request extends Format0Request {
	readonly streamHeader: string;
}

/** A single-shot note's settings, from what its write declares in either format. */
export function settingsOf(request: Format0Request | Format1Request): NoteSettings {
	if ("envelope" in request) {
		return { ...envelopeSettings(request.envelope), verifiers: verifiersOf(request) };
	}
	return format0Settings(request, format0Opening(request));
}

/** A chunked note's settings, from what its write declares in either format. */
export function chunkedSettingsOf(
	request: ChunkedFormat0Request | Format1Request,
): NoteSettings<ChunkedOpening> {
	if ("envelope" in request) {
		return { ...envelopeSettings(request.envelope), verifiers: verifiersOf(request) };
	}
	return chunkedFormat0Settings(request);
}

/**
 * A chunked note's settings, from what its upload session kept (uploads.ts):
 * the same fields as its write, but for format 1's verifiers, which the
 * server sealed as the session opened.
 */
export function sessionSettingsOf(
	session: ChunkedFormat0Request | Format1Request,
): StoredSettings<ChunkedOpening> {
	if ("envelope" in session) {
		const { linkVerifier, passwordVerifier } = session;
		return {
			...envelopeSettings(session.envelope),
			verifiers: {
				link: Buffer.from(linkVerifier) as SealedVerifier,
				...(passwordVerifier ? { password: Buffer.from(passwordVerifier) as SealedVerifier } : {}),
			},
		};
	}
	return chunkedFormat0Settings(session);
}

/** A format 1 note's settings: the envelope's, which is kept as it came. */
function envelopeSettings({
	bytes,
	envelope,
}: AcceptedEnvelope): NoteSettings<Format1Opening, never> {
	return {
		hasPassword: envelope.argon2 !== undefined,
		expiresIn: envelope.expiresIn,
		maxReads: envelope.maxReads,
		fileCount: envelope.fileCount,
		opening: { format: 1, envelope: Buffer.from(bytes) },
	};
}

/** A format 1 write's verifiers. The request schemas match the password's to the envelope. */
function verifiersOf(request: Format1Request): ReadVerifiers {
	return {
		link: request.linkVerifier,
		...(request.passwordVerifier ? { password: request.passwordVerifier } : {}),
	};
}

function chunkedFormat0Settings(
	request: ChunkedFormat0Request,
): NoteSettings<ChunkedFormat0Opening, never> {
	return format0Settings(request, {
		...format0Opening(request),
		streamHeader: request.streamHeader,
	});
}

/** Format 0 has no verifiers: whoever has the id is served. */
function format0Settings<Opening extends Format0Opening>(
	request: Format0Request,
	opening: Opening,
): NoteSettings<Opening, never> {
	return {
		hasPassword: request.hasPassword,
		expiresIn: request.expiresIn,
		maxReads: request.maxReads,
		fileCount: request.fileCount,
		opening,
	};
}

function format0Opening(request: Format0Request): Format0Opening {
	return {
		format: 0,
		clientNonce: request.clientNonce,
		...(request.salt !== undefined ? { salt: request.salt } : {}),
	};
}

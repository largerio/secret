import type { AcceptedEnvelope } from "@largerio/secret-shared";
import type {
	ChunkedOpening,
	Format0Opening,
	Format1Opening,
	NoteFormat,
	NoteOpening,
	NoteSettings,
	OpeningOf,
} from "./types.js";

/** Every format a note can be in, for a read that answers them all. */
export const NOTE_FORMATS: readonly NoteFormat[] = [0, 1];

/** What a format 1 write declares: its envelope, which says it all. */
export interface Format1Request {
	readonly envelope: AcceptedEnvelope;
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
		return format1Settings(request.envelope);
	}
	return format0Settings(request, format0Opening(request));
}

/** A chunked note's settings, from what its write declares in either format. */
export function chunkedSettingsOf(
	request: ChunkedFormat0Request | Format1Request,
): NoteSettings<ChunkedOpening> {
	if ("envelope" in request) {
		return format1Settings(request.envelope);
	}
	return format0Settings(request, {
		...format0Opening(request),
		streamHeader: request.streamHeader,
	});
}

/** Whether a note opened this way is of one of the given formats. */
export function isOfFormat<F extends NoteFormat>(
	opening: NoteOpening,
	formats: readonly F[],
): opening is OpeningOf<F> {
	const accepted: readonly NoteFormat[] = formats;
	return accepted.includes(opening.format);
}

/** A format 1 note's settings: the envelope's, which is kept as it came. */
function format1Settings({ bytes, envelope }: AcceptedEnvelope): NoteSettings<Format1Opening> {
	return {
		hasPassword: envelope.argon2 !== undefined,
		expiresIn: envelope.expiresIn,
		maxReads: envelope.maxReads,
		fileCount: envelope.fileCount,
		opening: { format: 1, envelope: Buffer.from(bytes) },
	};
}

function format0Settings<Opening extends Format0Opening>(
	request: Format0Request,
	opening: Opening,
): NoteSettings<Opening> {
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

import { z } from "zod";
import {
	MAX_ENCRYPTED_DATA_SIZE,
	MAX_EXPIRY_SECONDS,
	MAX_FILES_PER_NOTE,
	MAX_NONCE_LENGTH,
	MAX_PASSWORD_ATTEMPTS,
	MAX_READS,
	MIN_EXPIRY_SECONDS,
	NOTE_ID_LENGTH,
	PROOF_LENGTH,
	UPLOAD_ID_LENGTH,
} from "./constants.js";
import {
	ENVELOPE_LENGTH,
	ENVELOPE_LENGTH_WITH_PASSWORD,
	type Envelope,
	parseEnvelope,
} from "./envelope.js";

// Fields common to both the JSON and multipart create-note requests. The two
// differ only in how the encrypted payload is carried (inline vs multipart
// body) and in their fileCount floor, so everything else lives here.
const baseNoteFields = {
	clientNonce: z.string().min(1, "Client nonce is required").max(MAX_NONCE_LENGTH),
	hasPassword: z.boolean(),
	expiresIn: z
		.number()
		.int()
		.min(MIN_EXPIRY_SECONDS, `Minimum expiry is ${MIN_EXPIRY_SECONDS} seconds`)
		.max(MAX_EXPIRY_SECONDS, `Maximum expiry is ${MAX_EXPIRY_SECONDS} seconds`),
	maxReads: z.number().int().min(0).max(MAX_READS).default(1),
	salt: z.string().min(1).max(100).optional(),
} as const;

// Cross-field rule shared by every create-note schema: a password-protected
// note must also carry the salt used to derive its key.
const SALT_REQUIRED_REFINEMENT = {
	message: "Salt is required when password is set",
	path: ["salt"],
};
const saltMatchesPassword = (data: { hasPassword: boolean; salt?: string | undefined }): boolean =>
	!data.hasPassword || data.salt !== undefined;

export const createNoteSchema = z
	.object({
		...baseNoteFields,
		encryptedData: z.string().min(1, "Encrypted data is required").max(MAX_ENCRYPTED_DATA_SIZE),
		fileCount: z.number().int().min(0).max(MAX_FILES_PER_NOTE),
	})
	.refine(saltMatchesPassword, SALT_REQUIRED_REFINEMENT);

export const createNoteMultipartSchema = z
	.object({
		...baseNoteFields,
		fileCount: z.number().int().min(1).max(MAX_FILES_PER_NOTE),
	})
	.refine(saltMatchesPassword, SALT_REQUIRED_REFINEMENT);

// --- Format 1 ---

/** A format 1 envelope accepted by a write: its bytes, as they will be stored and served. */
export interface AcceptedEnvelope {
	readonly bytes: Uint8Array;
	readonly envelope: Envelope;
}

/**
 * A format 1 envelope in base64: well formed, and with settings within the
 * protocol's limits, which format 0 requests state as fields.
 */
function envelopeSchema(minFiles = 0) {
	return z
		.base64()
		.min(4 * Math.ceil(ENVELOPE_LENGTH / 3))
		.max(4 * Math.ceil(ENVELOPE_LENGTH_WITH_PASSWORD / 3))
		.transform((value, ctx): AcceptedEnvelope => {
			const bytes = new Uint8Array(Buffer.from(value, "base64"));
			const envelope = parseEnvelope(bytes);
			if (
				envelope === undefined ||
				envelope.fileCount < minFiles ||
				envelope.fileCount > MAX_FILES_PER_NOTE ||
				envelope.maxReads > MAX_READS ||
				envelope.expiresIn < MIN_EXPIRY_SECONDS ||
				envelope.expiresIn > MAX_EXPIRY_SECONDS
			) {
				ctx.addIssue({ code: "custom", message: "Invalid envelope" });
				return z.NEVER;
			}
			return { bytes, envelope };
		})
		.describe(
			"The note's format 1 envelope, in base64 (PROTOCOL.md): its settings and what opening it takes.",
		);
}

/** 32 bytes in base64: a read proof, or what checks one (PROTOCOL.md). */
function proofBytes(description: string) {
	return z
		.string()
		.regex(/^[A-Za-z0-9+/]{43}=$/, `Expected ${String(PROOF_LENGTH)} bytes in base64`)
		.transform((value) => new Uint8Array(Buffer.from(value, "base64")))
		.describe(description);
}

/** What a format 1 write sends beside its envelope, never inside it: the envelope is public. */
const format1Verifiers = {
	linkVerifier: proofBytes(
		"SHA-256 of the link proof its readers will send, in base64. Never served.",
	),
	passwordVerifier: proofBytes(
		"A password note's: SHA-256 of the password proof its readers will send, in base64. Never served.",
	).optional(),
};

// The envelope says whether the note has a password: a password verifier comes
// with one, and only with one.
const VERIFIERS_MATCH_ENVELOPE = {
	message: "A password verifier comes with a password note, and only with one",
	path: ["passwordVerifier"],
	// Only once the fields parsed: zod would otherwise run it on a refused envelope.
	when: (payload: { readonly issues: ReadonlyArray<unknown> }) => payload.issues.length === 0,
};
const verifiersMatchEnvelope = (data: {
	readonly envelope: AcceptedEnvelope;
	readonly passwordVerifier?: Uint8Array | undefined;
}): boolean =>
	(data.passwordVerifier !== undefined) === (data.envelope.envelope.argon2 !== undefined);

export const createNoteFormat1Schema = z
	.object({
		envelope: envelopeSchema(),
		...format1Verifiers,
		encryptedData: z.string().min(1, "Encrypted data is required").max(MAX_ENCRYPTED_DATA_SIZE),
	})
	.refine(verifiersMatchEnvelope, VERIFIERS_MATCH_ENVELOPE);

export const createNoteMultipartFormat1Schema = z
	.object({
		envelope: envelopeSchema(1),
		...format1Verifiers,
	})
	.refine(verifiersMatchEnvelope, VERIFIERS_MATCH_ENVELOPE);

export const chunkedUploadInitFormat1Schema = z
	.object({
		envelope: envelopeSchema(),
		...format1Verifiers,
		chunkCount: z.number().int().min(1).max(10000),
	})
	.refine(verifiersMatchEnvelope, VERIFIERS_MATCH_ENVELOPE);

/** `POST /notes/{id}/reads`: the proofs a format 1 reader derived from its link and password. */
export const noteReadRequestSchema = z.object({
	linkProof: proofBytes("HKDF of the link's key, in base64 (PROTOCOL.md): proves the link."),
	passwordProof: proofBytes(
		"A password note's: HKDF of the link's key and the stretched password, in base64. Ignored on a note without a password.",
	).optional(),
});

const NOTE_ID_RE = /^[A-Za-z0-9_-]+$/;

export const noteIdSchema = z
	.string()
	.regex(NOTE_ID_RE, "Invalid note ID format")
	.length(NOTE_ID_LENGTH, `Note ID must be ${String(NOTE_ID_LENGTH)} characters`);

/**
 * Runtime guard for note IDs met outside the routes' schemas: the storage
 * backends check with it the keys they list.
 * Single source of truth for the ID format — keep in sync with noteIdSchema.
 */
export function isValidNoteId(id: string): boolean {
	return id.length === NOTE_ID_LENGTH && NOTE_ID_RE.test(id);
}

// --- Response schemas ---

export const createNoteResponseSchema = z.object({
	id: z.string(),
	expiresAt: z.string(),
	deleteToken: z.string(),
});

export const noteExistsResponseSchema = z.object({
	exists: z.literal(true),
	hasPassword: z.boolean(),
	fileCount: z.number().int(),
	expiresAt: z.string(),
	maxReads: z.number().int(),
	readCount: z
		.number()
		.int()
		.min(0)
		.describe(
			"Reads already spent on the note. A read is spent once the ciphertext is served, " +
				"so on a format 0 note a wrong password still counts; on a format 1 note it does not. " +
				"Reads left: maxReads - readCount. Always 0 when maxReads is 0 (unlimited): how often " +
				"an unlimited note was opened is not disclosed.",
		),
	chunked: z.boolean(),
	envelope: z
		.base64()
		.optional()
		.describe(
			"A format 1 note's envelope, in base64: what its reader derives the proofs with. Absent for a format 0 note.",
		),
	passwordAttemptsLeft: z
		.number()
		.int()
		.min(1)
		.max(MAX_PASSWORD_ATTEMPTS)
		.optional()
		.describe(
			"A format 1 password note's: wrong passwords it still takes, the last of which deletes it. A wrong password spends no read.",
		),
});

export const noteNotFoundResponseSchema = z.object({
	exists: z.literal(false),
});

export const readNoteResponseSchema = z.object({
	encryptedData: z.string(),
	clientNonce: z.string(),
	hasPassword: z.boolean(),
	fileCount: z.number().int(),
	createdAt: z.string(),
	expiresAt: z.string(),
	salt: z.string().optional(),
});

export const deleteNoteResponseSchema = z.object({
	deleted: z.literal(true),
});

// --- Chunked upload schemas ---

/**
 * Shape of the JSON metadata persisted in an upload session row
 * (uploads.metadata column). Validated again on /complete so corrupted
 * rows surface as 500s instead of inserting malformed notes.
 */
export const uploadSessionMetadataSchema = z.object({
	streamHeader: z.string().min(1).max(MAX_NONCE_LENGTH),
	clientNonce: z.string().min(1).max(MAX_NONCE_LENGTH),
	hasPassword: z.boolean(),
	expiresIn: z.number().int().min(MIN_EXPIRY_SECONDS).max(MAX_EXPIRY_SECONDS),
	maxReads: z.number().int().min(0).max(MAX_READS),
	fileCount: z.number().int().min(0).max(MAX_FILES_PER_NOTE),
	salt: z.string().min(1).max(100).optional(),
});

export type UploadSessionMetadata = z.infer<typeof uploadSessionMetadataSchema>;

/**
 * The upload session row of a format 1 note: its envelope says the rest, but
 * for its verifiers, kept as the server sealed them.
 */
export const uploadSessionFormat1MetadataSchema = z
	.object({
		envelope: envelopeSchema(),
		linkVerifier: proofBytes("The link verifier, sealed by the server."),
		passwordVerifier: proofBytes("The password verifier, sealed by the server.").optional(),
	})
	.refine(verifiersMatchEnvelope, VERIFIERS_MATCH_ENVELOPE);

export const chunkedUploadInitSchema = uploadSessionMetadataSchema
	.extend({
		maxReads: z.number().int().min(0).max(MAX_READS).default(1),
		chunkCount: z.number().int().min(1).max(10000),
	})
	.refine((data) => !data.hasPassword || data.salt !== undefined, {
		message: "Salt is required when password is set",
		path: ["salt"],
	});

export const chunkedUploadInitResponseSchema = z.object({
	uploadId: z.string().length(UPLOAD_ID_LENGTH),
	expiresAt: z.string(),
});

export const chunkUploadResponseSchema = z.object({
	received: z.literal(true),
});

export const chunkedUploadCompleteResponseSchema = z.object({
	id: z.string(),
	expiresAt: z.string(),
	deleteToken: z.string(),
});

// --- Either format ---

// A request that carries an envelope is format 1's, whatever else it holds: an
// envelope refused must not let the same request through as format 0, which
// ignores the key. So the format 0 variants refuse it.
const NO_ENVELOPE = {
	// Documented as a string no value matches: the generator has no word for
	// a key that must be absent.
	envelope: z.never().optional().meta({
		type: "string",
		not: {},
		description: "Absent: a request with an envelope is a format 1 request.",
	}),
};

/** `POST /notes`: format 1's envelope, or format 0's fields. */
export const createNoteRequestSchema = z.union([
	createNoteFormat1Schema,
	createNoteSchema.safeExtend(NO_ENVELOPE),
]);

/** The `metadata` of `POST /notes/upload`: format 1's envelope, or format 0's fields. */
export const createNoteMultipartRequestSchema = z.union([
	createNoteMultipartFormat1Schema,
	createNoteMultipartSchema.safeExtend(NO_ENVELOPE),
]);

/** `POST /notes/upload/init`: format 1's envelope, or format 0's fields. */
export const chunkedUploadInitRequestSchema = z.union([
	chunkedUploadInitFormat1Schema,
	chunkedUploadInitSchema.safeExtend(NO_ENVELOPE),
]);

/** An upload session row, as either format leaves it. */
export const uploadSessionAnyMetadataSchema = z.union([
	uploadSessionFormat1MetadataSchema,
	uploadSessionMetadataSchema,
]);

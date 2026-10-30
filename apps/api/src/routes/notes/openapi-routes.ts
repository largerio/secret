import { createRoute, z } from "@hono/zod-openapi";
import {
	chunkedUploadCompleteResponseSchema,
	chunkedUploadInitRequestSchema,
	chunkedUploadInitResponseSchema,
	chunkUploadResponseSchema,
	createNoteRequestSchema,
	createNoteResponseSchema,
	deleteNoteResponseSchema,
	MAX_MESSAGE_LENGTH,
	MAX_PASSWORD_ATTEMPTS,
	noteExistsResponseSchema,
	noteIdSchema,
	noteNotFoundResponseSchema,
	noteReadRequestSchema,
	readNoteResponseSchema,
	UPLOAD_ID_LENGTH,
} from "@largerio/secret-shared";

// Reuse the shared note ID schema so the format is defined in one place.
const noteIdParam = noteIdSchema.openapi({
	param: { name: "id", in: "path" },
	example: "aBcDeFgHiJkL",
});

const uploadIdParam = z
	.string()
	.length(UPLOAD_ID_LENGTH)
	.regex(/^[A-Za-z0-9_-]+$/)
	.openapi({ param: { name: "uploadId", in: "path" } });

const binaryBody = z.string().openapi({ format: "binary" });

// Every route answers its errors as problem details (PROTOCOL.md, "Errors").
const problemSchema = z
	.object({
		type: z.literal("about:blank"),
		title: z.string(),
		status: z.number().int(),
		code: z.string().openapi({ example: "note_not_found" }),
		detail: z.string(),
		error: z.string().openapi({ description: "`detail` again, for clients written before codes." }),
		errorId: z
			.string()
			.optional()
			.openapi({ description: "A 500's: the instance logs it with the error." }),
	})
	.openapi("Problem");

const ERRORS = {
	default: {
		content: { "application/problem+json": { schema: problemSchema } },
		description: "An error, named by its `code` (PROTOCOL.md, Errors)",
	},
} as const;

// Every route below validates its parameters, headers and JSON or multipart
// body with these schemas (app.openapi): what the documentation says is what
// the API accepts. Two things are checked past them: a chunk's bytes, by the
// service, and the multipart `metadata` JSON, by its handler. A JSON or
// multipart body is `required`, or a request without a Content-Type would skip
// its validation and reach the handler empty.
//
// A write takes either format (PROTOCOL.md): format 1 sends one `envelope`,
// and the verifiers of its readers' proofs beside it, format 0 its settings
// field by field. A request with an envelope is format 1's (the shared request
// schemas). A read is of one format: the GETs serve format 0, `POST
// /{id}/reads` format 1, so that a client that knows only format 0 is refused
// a format 1 note before it spends a read on it.

const WRITE_FORMATS =
	"Format 1 sends `envelope`, the note's envelope in base64, which holds its settings, with `linkVerifier` and, for a password note, `passwordVerifier`; format 0 sends its settings as fields.";

const ONE_MESSAGE = `A format 1 note sent in one request is one message: its ciphertext, less its 17-byte tag, must be a size class (PROTOCOL.md, The body), or it is refused with 400, and it must be at most ${String(MAX_MESSAGE_LENGTH)} bytes, the most a read's 4-byte length frames, or it is refused with 413: both before anything is stored.`;

const FORMAT_0_ONLY =
	"Format 0 notes only: a format 1 note is refused with 400 before any read is spent, and is read from POST /{id}/reads.";

export const createNoteRoute = createRoute({
	method: "post",
	path: "/",
	tags: ["Notes"],
	summary: "Create an encrypted note (JSON)",
	description: `${WRITE_FORMATS} ${ONE_MESSAGE}`,
	request: {
		body: {
			content: {
				"application/json": { schema: createNoteRequestSchema },
			},
			required: true,
		},
	},
	responses: {
		...ERRORS,
		201: {
			content: { "application/json": { schema: createNoteResponseSchema } },
			description: "Note created",
		},
	},
});

export const uploadNoteRoute = createRoute({
	method: "post",
	path: "/upload",
	tags: ["Notes"],
	summary: "Create an encrypted note with a binary payload (multipart)",
	description: `Same as POST / but the encrypted payload travels as a binary multipart part (no base64 overhead). \`metadata\` is a JSON string with the same fields as the JSON create request, minus \`encryptedData\`: \`{"envelope", "linkVerifier"}\`, with \`"passwordVerifier"\` for a password note, in format 1. The note has at least one file. ${ONE_MESSAGE}`,
	request: {
		body: {
			content: {
				"multipart/form-data": {
					schema: z.object({
						metadata: z.string().openapi({
							description:
								"JSON-encoded note metadata: the envelope and its verifiers, or format 0's fields",
						}),
						data: z.instanceof(File).openapi({
							type: "string",
							format: "binary",
							description: "Client-encrypted payload bytes",
						}),
					}),
				},
			},
			required: true,
		},
	},
	responses: {
		...ERRORS,
		201: {
			content: { "application/json": { schema: createNoteResponseSchema } },
			description: "Note created",
		},
	},
});

export const existsRoute = createRoute({
	method: "get",
	path: "/{id}/exists",
	tags: ["Notes"],
	summary: "Check if a note exists",
	description:
		"Spends no read. `chunked` tells a format 0 note's reader which endpoint serves it, /stream or the others; it is false for every format 1 note, which POST /{id}/reads serves however it went up. For a format 1 note, the answer also carries its envelope, which its reader derives its proofs from, and for a password note the wrong passwords it still takes.",
	request: {
		params: z.object({ id: noteIdParam }),
	},
	responses: {
		...ERRORS,
		200: {
			content: {
				"application/json": {
					schema: z.union([noteExistsResponseSchema, noteNotFoundResponseSchema]),
				},
			},
			description: "Note existence check result",
		},
	},
});

export const readNoteRoute = createRoute({
	method: "get",
	path: "/{id}",
	tags: ["Notes"],
	summary: "Read and decrypt a note (server-side decryption layer only)",
	description: `The legacy JSON read. ${FORMAT_0_ONLY} A chunked note is refused likewise, and is read from /stream.`,
	request: {
		params: z.object({ id: noteIdParam }),
	},
	responses: {
		...ERRORS,
		200: {
			content: { "application/json": { schema: readNoteResponseSchema } },
			description: "Note data (still client-encrypted)",
		},
	},
});

export const rawNoteRoute = createRoute({
	method: "get",
	path: "/{id}/raw",
	tags: ["Notes"],
	summary: "Read a note as raw bytes (server-side decryption layer only)",
	description: `Returns the still client-encrypted payload as a binary body. Note metadata travels in response headers: X-Has-Password, X-File-Count, X-Created-At, X-Expires-At, X-Client-Nonce and X-Salt (when password-protected). ${FORMAT_0_ONLY}`,
	request: {
		params: z.object({ id: noteIdParam }),
	},
	responses: {
		...ERRORS,
		200: {
			content: { "application/octet-stream": { schema: binaryBody } },
			description: "Client-encrypted note bytes; metadata in X-* headers",
		},
	},
});

export const deleteNoteRoute = createRoute({
	method: "delete",
	path: "/{id}",
	tags: ["Notes"],
	summary: "Delete a note",
	request: {
		params: z.object({ id: noteIdParam }),
		headers: z.object({ "x-delete-token": z.string().openapi({ example: "abc123..." }) }),
	},
	responses: {
		...ERRORS,
		200: {
			content: { "application/json": { schema: deleteNoteResponseSchema } },
			description: "Note deleted",
		},
	},
});

export const uploadInitRoute = createRoute({
	method: "post",
	path: "/upload/init",
	tags: ["Notes"],
	summary: "Start a chunked upload session",
	description: `Creates an upload session for large notes. Chunks are then sent individually and the session is finalized via the complete endpoint. Sessions expire after one hour. ${WRITE_FORMATS} A format 1 note's chunks are the messages of its secretstream, whose lengths the complete endpoint checks.`,
	request: {
		body: {
			content: {
				"application/json": {
					schema: chunkedUploadInitRequestSchema,
				},
			},
			required: true,
		},
	},
	responses: {
		...ERRORS,
		201: {
			content: { "application/json": { schema: chunkedUploadInitResponseSchema } },
			description: "Upload session created",
		},
	},
});

export const uploadChunkRoute = createRoute({
	method: "put",
	path: "/upload/{uploadId}/chunks/{index}",
	tags: ["Notes"],
	summary: "Upload one encrypted chunk",
	description:
		"Sends a single secretstream chunk as a binary body. The X-Chunk-Hash header must carry the lower-case hex SHA-256 of the body. Sending a chunk again replaces it, once its first send has answered: while a chunk is being written, another send of the same index answers 409.",
	request: {
		params: z.object({
			uploadId: uploadIdParam,
			index: z
				.string()
				.regex(/^\d+$/)
				.openapi({ param: { name: "index", in: "path" }, example: "0" }),
		}),
		headers: z.object({
			"x-chunk-hash": z
				.string()
				.regex(/^[0-9a-f]{64}$/)
				.openapi({ description: "Lower-case hex SHA-256 of the chunk body" }),
		}),
		body: { content: { "application/octet-stream": { schema: binaryBody } } },
	},
	responses: {
		...ERRORS,
		200: {
			content: { "application/json": { schema: chunkUploadResponseSchema } },
			description: "Chunk received",
		},
	},
});

export const uploadCompleteRoute = createRoute({
	method: "post",
	path: "/upload/{uploadId}/complete",
	tags: ["Notes"],
	summary: "Finalize a chunked upload",
	description:
		"Verifies that every chunk arrived and turns the session into a readable note. It answers 409 while a chunk is still being written: complete once every chunk upload has answered. A format 1 note's messages must be those of a padded body (PROTOCOL.md, Messages): every message before the last as long as the first, the last no longer and not empty (more than its 17-byte tag), and their lengths, less 17 bytes each, adding up to a size class. Otherwise it answers 400 and creates no note. The session stays open, as one still missing chunks does, until it is completed, its messages sent again at the right lengths, or it expires and its chunks are purged.",
	request: {
		params: z.object({ uploadId: uploadIdParam }),
	},
	responses: {
		...ERRORS,
		201: {
			content: { "application/json": { schema: chunkedUploadCompleteResponseSchema } },
			description: "Note created from the uploaded chunks",
		},
	},
});

export const streamNoteRoute = createRoute({
	method: "get",
	path: "/{id}/stream",
	tags: ["Notes"],
	summary: "Read a chunked note as a binary stream",
	description: `Streams the still client-encrypted chunks with length-prefix framing: each chunk is preceded by a 4-byte big-endian length. Note metadata travels in response headers: X-Chunk-Count, X-Has-Password, X-File-Count, X-Created-At, X-Expires-At, X-Stream-Header and X-Salt (when password-protected). Returns 400 for non-chunked notes. ${FORMAT_0_ONLY}`,
	request: {
		params: z.object({ id: noteIdParam }),
	},
	responses: {
		...ERRORS,
		200: {
			content: { "application/octet-stream": { schema: binaryBody } },
			description: "Length-prefixed client-encrypted chunks; metadata in X-* headers",
		},
	},
});

export const readWithProofsRoute = createRoute({
	method: "post",
	path: "/{id}/reads",
	tags: ["Notes"],
	summary: "Read a format 1 note with the proofs of its link and password",
	description: `Format 1 notes only: a format 0 note is refused with 400, no read spent. Nothing is spent before the proofs check out: a wrong link proof answers 403 and counts nothing; a password note's read needs \`passwordProof\` (400 without it), and a wrong one answers 403 and counts a failed attempt. A note takes ${String(MAX_PASSWORD_ATTEMPTS)} over its life, and the last deletes it. Then the note's messages are served as /stream serves a chunked note's, each preceded by its 4-byte big-endian length, whether the note went up in one request (one message) or in an upload session. The headers are /stream's, X-Chunk-Count giving the number of messages, without X-Stream-Header and X-Salt: the reader has the envelope from /exists.`,
	request: {
		params: z.object({ id: noteIdParam }),
		body: {
			content: {
				"application/json": { schema: noteReadRequestSchema },
			},
			required: true,
		},
	},
	responses: {
		...ERRORS,
		200: {
			content: { "application/octet-stream": { schema: binaryBody } },
			description:
				"Length-prefixed client-encrypted messages (X-Chunk-Count of them); metadata in X-* headers",
		},
	},
});

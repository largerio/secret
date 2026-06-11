import { createRoute, z } from "@hono/zod-openapi";
import {
	chunkedUploadCompleteResponseSchema,
	chunkedUploadInitResponseSchema,
	chunkedUploadInitSchema,
	chunkUploadResponseSchema,
	createNoteResponseSchema,
	createNoteSchema,
	deleteNoteResponseSchema,
	noteExistsResponseSchema,
	noteIdSchema,
	noteNotFoundResponseSchema,
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
	.openapi({ param: { name: "uploadId", in: "path" } });

const binaryBody = z.string().openapi({ format: "binary" });

export const createNoteRoute = createRoute({
	method: "post",
	path: "/",
	tags: ["Notes"],
	summary: "Create an encrypted note (JSON)",
	request: {
		body: { content: { "application/json": { schema: createNoteSchema } } },
	},
	responses: {
		201: {
			content: { "application/json": { schema: createNoteResponseSchema } },
			description: "Note created",
		},
	},
});

// Documentation-only definition: the handler validates the multipart body
// manually (see standard.ts), so this route is registered on the OpenAPI
// registry without driving request validation.
export const uploadNoteRoute = createRoute({
	method: "post",
	path: "/upload",
	tags: ["Notes"],
	summary: "Create an encrypted note with a binary payload (multipart)",
	description:
		"Same as POST / but the encrypted payload travels as a binary multipart part (no base64 overhead). `metadata` is a JSON string with the same fields as the JSON create request, minus `encryptedData`.",
	request: {
		body: {
			content: {
				"multipart/form-data": {
					schema: z.object({
						metadata: z.string().openapi({ description: "JSON-encoded note metadata" }),
						data: binaryBody.openapi({ description: "Client-encrypted payload bytes" }),
					}),
				},
			},
		},
	},
	responses: {
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
	request: {
		params: z.object({ id: noteIdParam }),
	},
	responses: {
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
	request: {
		params: z.object({ id: noteIdParam }),
	},
	responses: {
		200: {
			content: { "application/json": { schema: readNoteResponseSchema } },
			description: "Note data (still client-encrypted)",
		},
	},
});

// Documentation-only definition for the binary read endpoint (see standard.ts).
export const rawNoteRoute = createRoute({
	method: "get",
	path: "/{id}/raw",
	tags: ["Notes"],
	summary: "Read a note as raw bytes (server-side decryption layer only)",
	description:
		"Returns the still client-encrypted payload as a binary body. Note metadata travels in response headers: X-Client-Nonce, X-Has-Password, X-File-Count, X-Created-At, X-Expires-At, and X-Salt (when password-protected).",
	request: {
		params: z.object({ id: noteIdParam }),
	},
	responses: {
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
		200: {
			content: { "application/json": { schema: deleteNoteResponseSchema } },
			description: "Note deleted",
		},
	},
});

// Documentation-only definitions for the chunked upload/stream endpoints
// (see chunked.ts): the handlers validate manually, so these routes are
// registered on the OpenAPI registry without driving request validation.

export const uploadInitRoute = createRoute({
	method: "post",
	path: "/upload/init",
	tags: ["Notes"],
	summary: "Start a chunked upload session",
	description:
		"Creates an upload session for large notes. Chunks are then sent individually and the session is finalized via the complete endpoint. Sessions expire after one hour.",
	request: {
		body: { content: { "application/json": { schema: chunkedUploadInitSchema } } },
	},
	responses: {
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
		"Sends a single secretstream chunk as a binary body. The X-Chunk-Hash header must carry the hex-encoded SHA-256 of the body. Re-uploading the same index is idempotent.",
	request: {
		params: z.object({
			uploadId: uploadIdParam,
			index: z
				.string()
				.regex(/^\d+$/)
				.openapi({ param: { name: "index", in: "path" }, example: "0" }),
		}),
		headers: z.object({
			"x-chunk-hash": z.string().openapi({ description: "Hex-encoded SHA-256 of the chunk body" }),
		}),
		body: { content: { "application/octet-stream": { schema: binaryBody } } },
	},
	responses: {
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
	description: "Verifies that every chunk arrived and turns the session into a readable note.",
	request: {
		params: z.object({ uploadId: uploadIdParam }),
	},
	responses: {
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
	description:
		"Streams the still client-encrypted chunks with length-prefix framing: each chunk is preceded by a 4-byte big-endian length. Note metadata travels in response headers (X-Stream-Header, X-Chunk-Count, X-Has-Password, X-File-Count, X-Created-At, X-Expires-At, X-Salt). Returns 400 for non-chunked notes.",
	request: {
		params: z.object({ id: noteIdParam }),
	},
	responses: {
		200: {
			content: { "application/octet-stream": { schema: binaryBody } },
			description: "Length-prefixed client-encrypted chunks; metadata in X-* headers",
		},
	},
});

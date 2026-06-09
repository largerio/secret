import { createRoute, z } from "@hono/zod-openapi";
import {
	createNoteResponseSchema,
	createNoteSchema,
	deleteNoteResponseSchema,
	noteExistsResponseSchema,
	noteIdSchema,
	noteNotFoundResponseSchema,
	readNoteResponseSchema,
} from "@largerio/shared";

// Reuse the shared note ID schema so the format is defined in one place.
const noteIdParam = noteIdSchema.openapi({
	param: { name: "id", in: "path" },
	example: "aBcDeFgHiJkL",
});

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

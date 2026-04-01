import { timingSafeEqual } from "node:crypto";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { serverDecrypt, serverEncrypt } from "@secret/crypto";
import {
	createNoteMultipartSchema,
	createNoteResponseSchema,
	createNoteSchema,
	deleteNoteResponseSchema,
	NOTE_ID_LENGTH,
	noteExistsResponseSchema,
	readNoteResponseSchema,
} from "@secret/shared";
import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { nanoid } from "nanoid";
import type { AppDatabase } from "../db/index.js";
import { notes } from "../db/schema.js";
import type { StorageBackend } from "../storage/index.js";

const DELETE_TOKEN_LENGTH = 32;

function httpError(status: 400 | 401 | 403 | 404 | 500, message: string): never {
	throw new HTTPException(status, { message });
}

interface NotesEnv {
	Variables: {
		db: AppDatabase;
		serverKey: Buffer;
		storage: StorageBackend;
	};
}

const noteIdParam = z
	.string()
	.regex(/^[A-Za-z0-9_-]+$/, "Invalid note ID format")
	.length(NOTE_ID_LENGTH, `Note ID must be ${String(NOTE_ID_LENGTH)} characters`)
	.openapi({ param: { name: "id", in: "path" }, example: "aBcDeFgHiJkL" });

// --- Route definitions ---

const createNoteRoute = createRoute({
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

const existsRoute = createRoute({
	method: "get",
	path: "/{id}/exists",
	tags: ["Notes"],
	summary: "Check if a note exists",
	request: {
		params: z.object({ id: noteIdParam }),
	},
	responses: {
		200: {
			content: { "application/json": { schema: noteExistsResponseSchema } },
			description: "Note exists",
		},
	},
});

const readNoteRoute = createRoute({
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

const deleteNoteRoute = createRoute({
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

// --- Handlers ---

export function createNotesRoutes() {
	const app = new OpenAPIHono<NotesEnv>({
		defaultHook: (result, c) => {
			if (!result.success) {
				return c.json({ error: "Invalid request" }, 400);
			}
		},
	});

	async function insertNote(
		db: AppDatabase,
		serverKey: Buffer,
		storage: StorageBackend,
		params: {
			clientBlob: Buffer;
			clientNonce: string;
			hasPassword: boolean;
			expiresIn: number;
			maxReads: number;
			fileCount: number;
			salt: string | null;
		},
	) {
		const { encrypted: serverBlob, iv: serverIv } = serverEncrypt(params.clientBlob, serverKey);

		const id = nanoid(NOTE_ID_LENGTH);
		const deleteToken = nanoid(DELETE_TOKEN_LENGTH);
		const now = new Date();
		const expiresAt = new Date(now.getTime() + params.expiresIn * 1000);

		let filePath: string | null = null;
		let storedBlob: Buffer;
		if (params.fileCount > 0) {
			filePath = await storage.save(id, serverBlob);
			storedBlob = Buffer.alloc(0);
		} else {
			storedBlob = serverBlob;
		}

		db.insert(notes)
			.values({
				id,
				encryptedData: storedBlob,
				serverNonce: serverIv.toString("base64"),
				clientNonce: params.clientNonce,
				hasPassword: params.hasPassword,
				salt: params.salt,
				deleteToken,
				burnAfterRead: params.maxReads === 1,
				fileCount: params.fileCount,
				filePath,
				expiresAt,
				maxReads: params.maxReads,
				createdAt: now,
			})
			.run();

		return { id, expiresAt: expiresAt.toISOString(), deleteToken };
	}

	app.openapi(createNoteRoute, async (c) => {
		const { encryptedData, clientNonce, hasPassword, expiresIn, maxReads, fileCount, salt } =
			c.req.valid("json");

		const result = await insertNote(c.get("db"), c.get("serverKey"), c.get("storage"), {
			clientBlob: Buffer.from(encryptedData, "base64"),
			clientNonce,
			hasPassword,
			expiresIn,
			maxReads,
			fileCount,
			salt: salt ?? null,
		});

		return c.json(result, 201);
	});

	app.post("/upload", async (c) => {
		let formData: FormData;
		try {
			formData = await c.req.formData();
		} catch {
			return c.json({ error: "Invalid multipart body" }, 400);
		}

		const metadataRaw = formData.get("metadata");
		const dataBlob = formData.get("data");

		if (typeof metadataRaw !== "string") {
			return c.json({ error: "Missing metadata part" }, 400);
		}
		if (!(dataBlob instanceof File)) {
			return c.json({ error: "Missing data part" }, 400);
		}

		let metadata: unknown;
		try {
			metadata = JSON.parse(metadataRaw);
		} catch {
			return c.json({ error: "Invalid metadata JSON" }, 400);
		}

		const parsed = createNoteMultipartSchema.safeParse(metadata);
		if (!parsed.success) {
			return c.json({ error: "Invalid request" }, 400);
		}

		const { clientNonce, hasPassword, expiresIn, maxReads, fileCount, salt } = parsed.data;

		const result = await insertNote(c.get("db"), c.get("serverKey"), c.get("storage"), {
			clientBlob: Buffer.from(await dataBlob.arrayBuffer()),
			clientNonce,
			hasPassword,
			expiresIn,
			maxReads,
			fileCount,
			salt: salt ?? null,
		});

		return c.json(result, 201);
	});

	app.openapi(existsRoute, (c) => {
		const { id } = c.req.valid("param");

		const db = c.get("db");
		const note = db
			.select({
				hasPassword: notes.hasPassword,
				fileCount: notes.fileCount,
				expiresAt: notes.expiresAt,
				maxReads: notes.maxReads,
			})
			.from(notes)
			.where(eq(notes.id, id))
			.get();

		if (note === undefined || note.expiresAt < new Date()) {
			httpError(404, "Note not found");
		}

		return c.json({
			exists: true as const,
			hasPassword: note.hasPassword,
			fileCount: note.fileCount,
			expiresAt: note.expiresAt.toISOString(),
			maxReads: note.maxReads ?? 0,
		});
	});

	async function consumeNote(
		db: AppDatabase,
		serverKey: Buffer,
		storage: StorageBackend,
		id: string,
	) {
		const result = db.transaction((tx) => {
			const note = tx.select().from(notes).where(eq(notes.id, id)).get();

			if (note === undefined) {
				return { error: "Note not found" as const, status: 404 as const };
			}

			if (note.expiresAt < new Date()) {
				tx.delete(notes).where(eq(notes.id, id)).run();
				return {
					error: "Note has expired" as const,
					status: 404 as const,
					filePath: note.filePath,
				};
			}

			const maxReads = note.maxReads ?? 0;
			const newReadCount = note.readCount + 1;
			const shouldDelete = maxReads > 0 && newReadCount >= maxReads;

			if (shouldDelete) {
				tx.delete(notes).where(eq(notes.id, id)).run();
			} else {
				tx.update(notes).set({ readCount: newReadCount }).where(eq(notes.id, id)).run();
			}

			return { note, shouldDelete };
		});

		if ("error" in result) {
			if ("filePath" in result && result.filePath) {
				await storage.delete(result.filePath).catch((err: unknown) => {
					console.error(
						`[notes] Failed to delete file for expired note:`,
						err instanceof Error ? err.message : err,
					);
				});
			}
			httpError(result.status as 404, result.error);
		}

		const { note } = result;
		const serverIv = Buffer.from(note.serverNonce, "base64");

		let clientBlob: Buffer;
		try {
			if (note.filePath) {
				const fileData = await storage.read(note.filePath);
				clientBlob = serverDecrypt(fileData, serverIv, serverKey);
			} else {
				clientBlob = serverDecrypt(note.encryptedData, serverIv, serverKey);
			}
		} catch {
			httpError(500, "Failed to decrypt note");
		}

		if (result.shouldDelete && note.filePath) {
			await storage.delete(note.filePath).catch((err: unknown) => {
				console.error(
					`[notes] Failed to delete file for burned note ${id}:`,
					err instanceof Error ? err.message : err,
				);
			});
		}

		return { clientBlob, note };
	}

	app.openapi(readNoteRoute, async (c) => {
		const { id } = c.req.valid("param");
		const { clientBlob, note } = await consumeNote(
			c.get("db"),
			c.get("serverKey"),
			c.get("storage"),
			id,
		);

		return c.json({
			encryptedData: clientBlob.toString("base64"),
			clientNonce: note.clientNonce,
			hasPassword: note.hasPassword,
			...(note.salt ? { salt: note.salt } : {}),
			fileCount: note.fileCount,
			createdAt: note.createdAt.toISOString(),
			expiresAt: note.expiresAt.toISOString(),
		});
	});

	app.get("/:id/raw", async (c) => {
		const id = c.req.param("id");
		if (!id || !/^[A-Za-z0-9_-]+$/.test(id) || id.length !== NOTE_ID_LENGTH) {
			return c.json({ error: "Invalid note ID" }, 400);
		}

		const { clientBlob, note } = await consumeNote(
			c.get("db"),
			c.get("serverKey"),
			c.get("storage"),
			id,
		);

		const headers: Record<string, string> = {
			"Content-Type": "application/octet-stream",
			"Content-Length": String(clientBlob.length),
			"X-Client-Nonce": note.clientNonce,
			"X-Has-Password": String(note.hasPassword),
			"X-File-Count": String(note.fileCount),
			"X-Created-At": note.createdAt.toISOString(),
			"X-Expires-At": note.expiresAt.toISOString(),
		};
		if (note.salt) {
			headers["X-Salt"] = note.salt;
		}

		return new Response(new Uint8Array(clientBlob) as BodyInit, { status: 200, headers });
	});

	app.openapi(deleteNoteRoute, async (c) => {
		const { id } = c.req.valid("param");
		const token = c.req.valid("header")["x-delete-token"];

		const db = c.get("db");
		const storage = c.get("storage");
		const note = db
			.select({ filePath: notes.filePath, deleteToken: notes.deleteToken })
			.from(notes)
			.where(eq(notes.id, id))
			.get();

		if (note === undefined) {
			httpError(404, "Note not found");
		}

		const tokenBuf = Buffer.from(token);
		const storedBuf = Buffer.from(note.deleteToken);
		if (tokenBuf.length !== storedBuf.length || !timingSafeEqual(tokenBuf, storedBuf)) {
			httpError(403, "Invalid delete token");
		}

		db.delete(notes).where(eq(notes.id, id)).run();

		if (note.filePath) {
			await storage.delete(note.filePath).catch((err: unknown) => {
				console.error(
					`[notes] Failed to delete file for note ${id}:`,
					err instanceof Error ? err.message : err,
				);
			});
		}

		return c.json({ deleted: true as const });
	});

	return app;
}

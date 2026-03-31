import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { createNoteSchema, noteIdSchema, NOTE_ID_LENGTH } from "@secret/shared";
import { serverEncrypt, serverDecrypt } from "@secret/crypto";
import type { AppDatabase } from "../db/index.js";
import { notes } from "../db/schema.js";
import { saveFile, readFile, deleteFile } from "../storage/files.js";

const DELETE_TOKEN_LENGTH = 32;

interface NotesEnv {
	Variables: {
		db: AppDatabase;
		serverKey: Buffer;
		filesPath: string;
	};
}

export function createNotesRoutes() {
	const app = new Hono<NotesEnv>();

	app.post("/", async (c) => {
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}
		const parsed = createNoteSchema.safeParse(body);

		if (!parsed.success) {
			return c.json({ error: "Invalid request" }, 400);
		}

		const { encryptedData, clientNonce, hasPassword, burnAfterRead, expiresIn, maxReads, fileCount, salt } = parsed.data;

		const db = c.get("db");
		const serverKey = c.get("serverKey");
		const filesPath = c.get("filesPath");

		const clientBlob = Buffer.from(encryptedData, "base64");
		const { encrypted: serverBlob, iv: serverIv } = serverEncrypt(clientBlob, serverKey);

		const id = nanoid(NOTE_ID_LENGTH);
		const deleteToken = nanoid(DELETE_TOKEN_LENGTH);
		const now = new Date();
		const expiresAt = new Date(now.getTime() + expiresIn * 1000);

		let filePath: string | null = null;
		let storedBlob: Buffer;
		if (fileCount > 0) {
			filePath = saveFile(filesPath, id, serverBlob);
			storedBlob = Buffer.alloc(0);
		} else {
			storedBlob = serverBlob;
		}

		db.insert(notes)
			.values({
				id,
				encryptedData: storedBlob,
				serverNonce: serverIv.toString("base64"),
				clientNonce,
				hasPassword,
				salt: salt ?? null,
				deleteToken,
				burnAfterRead,
				fileCount,
				filePath,
				expiresAt,
				maxReads: maxReads ?? null,
				createdAt: now,
			})
			.run();

		return c.json({ id, expiresAt: expiresAt.toISOString(), deleteToken }, 201);
	});

	app.get("/:id/exists", (c) => {
		const id = noteIdSchema.safeParse(c.req.param("id"));
		if (!id.success) {
			return c.json({ error: "Invalid note ID" }, 400);
		}

		const db = c.get("db");
		const note = db.select({
			hasPassword: notes.hasPassword,
			fileCount: notes.fileCount,
			expiresAt: notes.expiresAt,
			burnAfterRead: notes.burnAfterRead,
		}).from(notes).where(eq(notes.id, id.data)).get();

		if (note === undefined) {
			return c.json({ exists: false }, 404);
		}

		if (note.expiresAt < new Date()) {
			return c.json({ exists: false }, 404);
		}

		return c.json({
			exists: true,
			hasPassword: note.hasPassword,
			fileCount: note.fileCount,
			expiresAt: note.expiresAt.toISOString(),
			burnAfterRead: note.burnAfterRead,
		});
	});

	app.get("/:id", (c) => {
		const id = noteIdSchema.safeParse(c.req.param("id"));
		if (!id.success) {
			return c.json({ error: "Invalid note ID" }, 400);
		}

		const db = c.get("db");
		const serverKey = c.get("serverKey");

		const result = db.transaction((tx) => {
			const note = tx.select().from(notes).where(eq(notes.id, id.data)).get();

			if (note === undefined) {
				return { error: "Note not found" as const, status: 404 as const };
			}

			if (note.expiresAt < new Date()) {
				tx.delete(notes).where(eq(notes.id, id.data)).run();
				if (note.filePath) deleteFile(note.filePath);
				return { error: "Note has expired" as const, status: 404 as const };
			}

			if (note.maxReads !== null && note.readCount >= note.maxReads) {
				tx.delete(notes).where(eq(notes.id, id.data)).run();
				if (note.filePath) deleteFile(note.filePath);
				return { error: "Note has reached maximum reads" as const, status: 404 as const };
			}

			if (note.burnAfterRead) {
				tx.delete(notes).where(eq(notes.id, id.data)).run();
			} else {
				tx.update(notes)
					.set({ readCount: note.readCount + 1 })
					.where(eq(notes.id, id.data))
					.run();
			}

			return { note };
		});

		if ("error" in result) {
			return c.json({ error: result.error }, result.status);
		}

		const { note } = result;
		const serverIv = Buffer.from(note.serverNonce, "base64");

		let clientBlob: Buffer;
		if (note.filePath) {
			const fileData = readFile(note.filePath);
			clientBlob = serverDecrypt(fileData, serverIv, serverKey);
		} else {
			clientBlob = serverDecrypt(note.encryptedData, serverIv, serverKey);
		}

		if (note.burnAfterRead && note.filePath) {
			deleteFile(note.filePath);
		}

		return c.json({
			encryptedData: clientBlob.toString("base64"),
			clientNonce: note.clientNonce,
			hasPassword: note.hasPassword,
			salt: note.salt ?? undefined,
			fileCount: note.fileCount,
			createdAt: note.createdAt.toISOString(),
			expiresAt: note.expiresAt.toISOString(),
		});
	});

	app.delete("/:id", (c) => {
		const id = noteIdSchema.safeParse(c.req.param("id"));
		if (!id.success) {
			return c.json({ error: "Invalid note ID" }, 400);
		}

		const token = c.req.header("x-delete-token");
		if (!token) {
			return c.json({ error: "Delete token required" }, 401);
		}

		const db = c.get("db");
		const note = db.select({ filePath: notes.filePath, deleteToken: notes.deleteToken })
			.from(notes)
			.where(eq(notes.id, id.data))
			.get();

		if (note === undefined) {
			return c.json({ error: "Note not found" }, 404);
		}

		if (note.deleteToken !== token) {
			return c.json({ error: "Invalid delete token" }, 403);
		}

		if (note.filePath) {
			deleteFile(note.filePath);
		}

		db.delete(notes).where(eq(notes.id, id.data)).run();
		return c.json({ deleted: true });
	});

	return app;
}

import { blob, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const notes = sqliteTable("notes", {
	id: text("id").primaryKey(),
	encryptedData: blob("encrypted_data", { mode: "buffer" }).notNull(),
	serverNonce: text("server_nonce").notNull(),
	clientNonce: text("client_nonce").notNull(),
	hasPassword: integer("has_password", { mode: "boolean" }).notNull().default(false),
	salt: text("salt"),
	burnAfterRead: integer("burn_after_read", { mode: "boolean" }).notNull().default(false),
	fileCount: integer("file_count").notNull().default(0),
	deleteToken: text("delete_token").notNull(),
	filePath: text("file_path"),
	expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
	readCount: integer("read_count").notNull().default(0),
	maxReads: integer("max_reads"),
	createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
	chunkCount: integer("chunk_count"),
	streamHeader: text("stream_header"),
});

export const uploads = sqliteTable("uploads", {
	id: text("id").primaryKey(),
	metadata: text("metadata").notNull(),
	chunkCount: integer("chunk_count").notNull(),
	chunksReceived: text("chunks_received").notNull().default("[]"),
	noteId: text("note_id").notNull(),
	deleteToken: text("delete_token").notNull(),
	createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
	expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
});

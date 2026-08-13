import { blob, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const notes = sqliteTable(
	"notes",
	{
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
		sizeBytes: integer("size_bytes").notNull().default(0),
	},
	(t) => [
		index("idx_notes_expires_at").on(t.expiresAt),
		index("idx_notes_delete_token").on(t.deleteToken),
	],
);

// Small key/value table for instance-level bookkeeping that must survive
// restarts — currently only the server-key fingerprint (see keyGuard.ts).
export const meta = sqliteTable("meta", {
	key: text("key").primaryKey(),
	value: text("value").notNull(),
});

export const uploads = sqliteTable(
	"uploads",
	{
		id: text("id").primaryKey(),
		metadata: text("metadata").notNull(),
		chunkCount: integer("chunk_count").notNull(),
		noteId: text("note_id").notNull(),
		deleteToken: text("delete_token").notNull(),
		createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
		expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
	},
	(t) => [index("idx_uploads_expires_at").on(t.expiresAt)],
);

export const uploadChunks = sqliteTable(
	"upload_chunks",
	{
		uploadId: text("upload_id")
			.notNull()
			.references(() => uploads.id, { onDelete: "cascade" }),
		chunkIndex: integer("chunk_index").notNull(),
		sizeBytes: integer("size_bytes").notNull().default(0),
	},
	(t) => [primaryKey({ columns: [t.uploadId, t.chunkIndex] })],
);

// Records storage objects we failed to delete during note expiration / consume
// flows. The cleanup job drains this table on each tick so that orphaned
// chunks/files are eventually removed even if the original deletion attempt
// failed (transient S3 outage, missing file at boot, etc.).
export const pendingDeletions = sqliteTable(
	"pending_deletions",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		noteId: text("note_id").notNull(),
		filePath: text("file_path"),
		chunkCount: integer("chunk_count"),
		attempts: integer("attempts").notNull().default(0),
		nextRetryAt: integer("next_retry_at", { mode: "timestamp" }).notNull(),
		createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
	},
	(t) => [index("idx_pending_deletions_next_retry").on(t.nextRetryAt)],
);

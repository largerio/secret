import { sqliteTable, text, integer, blob } from "drizzle-orm/sqlite-core";

export const notes = sqliteTable("notes", {
	id: text("id").primaryKey(),
	encryptedData: blob("encrypted_data", { mode: "buffer" }).notNull(),
	serverNonce: text("server_nonce").notNull(),
	clientNonce: text("client_nonce").notNull(),
	hasPassword: integer("has_password", { mode: "boolean" }).notNull().default(false),
	burnAfterRead: integer("burn_after_read", { mode: "boolean" }).notNull().default(false),
	fileCount: integer("file_count").notNull().default(0),
	filePath: text("file_path"),
	expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
	readCount: integer("read_count").notNull().default(0),
	maxReads: integer("max_reads"),
	createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

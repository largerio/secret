CREATE TABLE `meta` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `notes` (
	`id` text PRIMARY KEY,
	`encrypted_data` blob NOT NULL,
	`server_nonce` text NOT NULL,
	`client_nonce` text NOT NULL,
	`has_password` integer DEFAULT false NOT NULL,
	`salt` text,
	`burn_after_read` integer DEFAULT false NOT NULL,
	`file_count` integer DEFAULT 0 NOT NULL,
	`delete_token` text NOT NULL,
	`file_path` text,
	`expires_at` integer NOT NULL,
	`read_count` integer DEFAULT 0 NOT NULL,
	`max_reads` integer,
	`created_at` integer NOT NULL,
	`chunk_count` integer,
	`stream_header` text
);
--> statement-breakpoint
CREATE TABLE `pending_deletions` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`note_id` text NOT NULL,
	`file_path` text,
	`chunk_count` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_retry_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `upload_chunks` (
	`upload_id` text NOT NULL,
	`chunk_index` integer NOT NULL,
	CONSTRAINT `upload_chunks_pk` PRIMARY KEY(`upload_id`, `chunk_index`),
	CONSTRAINT `fk_upload_chunks_upload_id_uploads_id_fk` FOREIGN KEY (`upload_id`) REFERENCES `uploads`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `uploads` (
	`id` text PRIMARY KEY,
	`metadata` text NOT NULL,
	`chunk_count` integer NOT NULL,
	`note_id` text NOT NULL,
	`delete_token` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_notes_expires_at` ON `notes` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_notes_delete_token` ON `notes` (`delete_token`);--> statement-breakpoint
CREATE INDEX `idx_pending_deletions_next_retry` ON `pending_deletions` (`next_retry_at`);--> statement-breakpoint
CREATE INDEX `idx_uploads_expires_at` ON `uploads` (`expires_at`);
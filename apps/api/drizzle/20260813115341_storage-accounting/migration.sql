ALTER TABLE `notes` ADD `size_bytes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `upload_chunks` ADD `size_bytes` integer DEFAULT 0 NOT NULL;
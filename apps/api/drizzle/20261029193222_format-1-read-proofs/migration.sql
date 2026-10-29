ALTER TABLE `notes` ADD `link_verifier` blob;--> statement-breakpoint
ALTER TABLE `notes` ADD `password_verifier` blob;--> statement-breakpoint
ALTER TABLE `notes` ADD `failed_attempts` integer DEFAULT 0 NOT NULL;
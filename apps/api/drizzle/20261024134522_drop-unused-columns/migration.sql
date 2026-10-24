DROP INDEX IF EXISTS `idx_notes_delete_token`;--> statement-breakpoint
ALTER TABLE `notes` DROP COLUMN `burn_after_read`;
ALTER TABLE `conversations` ADD `pinned_at` integer;--> statement-breakpoint
ALTER TABLE `conversations` ADD `archived_at` integer;--> statement-breakpoint
ALTER TABLE `conversations` ADD `marked_unread` integer DEFAULT false NOT NULL;
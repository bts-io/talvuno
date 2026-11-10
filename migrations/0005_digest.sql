ALTER TABLE `user_preferences` ADD `digest_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `user_preferences` ADD `digest_time` text DEFAULT '08:00' NOT NULL;--> statement-breakpoint
ALTER TABLE `user_preferences` ADD `timezone` text DEFAULT 'UTC' NOT NULL;--> statement-breakpoint
ALTER TABLE `user_preferences` ADD `last_digest_date` text;--> statement-breakpoint
ALTER TABLE `user_preferences` ADD `last_digest_at` integer;
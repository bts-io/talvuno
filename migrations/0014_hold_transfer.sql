ALTER TABLE `calls` ADD `on_hold_at` integer;--> statement-breakpoint
ALTER TABLE `calls` ADD `hold_queue` text;--> statement-breakpoint
ALTER TABLE `calls` ADD `remote_call_sid` text;--> statement-breakpoint
ALTER TABLE `calls` ADD `transferred_to` text;--> statement-breakpoint
ALTER TABLE `calls` ADD `transferred_at` integer;
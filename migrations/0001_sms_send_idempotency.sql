ALTER TABLE `messages` ADD `error_message` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `client_id` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `media` text;--> statement-breakpoint
CREATE UNIQUE INDEX `messages_owner_client_id_idx` ON `messages` (`owner_id`,`client_id`);
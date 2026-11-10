CREATE TABLE `number_menus` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`number_id` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`prompt` text DEFAULT '' NOT NULL,
	`keys` text DEFAULT '[]' NOT NULL,
	`default_action` text DEFAULT 'ring' NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`number_id`) REFERENCES `phone_numbers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `number_menus_number_id_unique` ON `number_menus` (`number_id`);--> statement-breakpoint
CREATE INDEX `number_menus_owner_idx` ON `number_menus` (`owner_id`);--> statement-breakpoint
ALTER TABLE `calls` ADD `forwarded_to` text;
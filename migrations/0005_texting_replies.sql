CREATE TABLE `missed_call_settings` (
	`number_id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`number_id`) REFERENCES `phone_numbers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `missed_call_texts` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`number_id` text NOT NULL,
	`caller` text NOT NULL,
	`day` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`number_id`) REFERENCES `phone_numbers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `missed_call_texts_number_caller_day_idx` ON `missed_call_texts` (`number_id`,`caller`,`day`);--> statement-breakpoint
CREATE TABLE `quick_replies` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`text` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `quick_replies_owner_sort_idx` ON `quick_replies` (`owner_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `quick_reply_state` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`seeded_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);

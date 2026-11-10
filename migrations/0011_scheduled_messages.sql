CREATE TABLE `scheduled_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`number_id` text NOT NULL,
	`to` text NOT NULL,
	`body` text NOT NULL,
	`send_at` integer NOT NULL,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`message_id` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`number_id`) REFERENCES `phone_numbers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `scheduled_messages_due_idx` ON `scheduled_messages` (`status`,`send_at`);--> statement-breakpoint
CREATE INDEX `scheduled_messages_owner_idx` ON `scheduled_messages` (`owner_id`,`status`,`send_at`);
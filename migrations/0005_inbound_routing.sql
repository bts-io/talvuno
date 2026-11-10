CREATE TABLE `blocked_numbers` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`e164` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `blocked_numbers_owner_e164_idx` ON `blocked_numbers` (`owner_id`,`e164`);--> statement-breakpoint
CREATE TABLE `number_routing` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`number_id` text NOT NULL,
	`ring_seconds` integer DEFAULT 25 NOT NULL,
	`voicemail_greeting` text,
	`hours` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`number_id`) REFERENCES `phone_numbers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `number_routing_number_id_unique` ON `number_routing` (`number_id`);--> statement-breakpoint
CREATE INDEX `number_routing_owner_idx` ON `number_routing` (`owner_id`);--> statement-breakpoint
CREATE TABLE `routing_settings` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`dnd` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `calls` ADD `outcome` text;--> statement-breakpoint
ALTER TABLE `calls` ADD `queue_name` text;--> statement-breakpoint
ALTER TABLE `calls` ADD `answer_call_sid` text;--> statement-breakpoint
ALTER TABLE `calls` ADD `answer_claimed_at` integer;--> statement-breakpoint
ALTER TABLE `calls` ADD `declined_at` integer;
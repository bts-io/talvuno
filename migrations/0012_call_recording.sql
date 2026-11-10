CREATE TABLE `call_recordings` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`call_id` text NOT NULL,
	`number_id` text,
	`duration` integer,
	`channels` integer DEFAULT 2 NOT NULL,
	`twilio_recording_sid` text NOT NULL,
	`r2_key` text,
	`content_type` text,
	`size` integer,
	`store_attempts` integer DEFAULT 0 NOT NULL,
	`store_error` text,
	`twilio_deleted_at` integer,
	`transcript` text,
	`transcript_status` text DEFAULT 'pending' NOT NULL,
	`transcript_error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`call_id`) REFERENCES `calls`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`number_id`) REFERENCES `phone_numbers`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `call_recordings_twilio_recording_sid_unique` ON `call_recordings` (`twilio_recording_sid`);--> statement-breakpoint
CREATE INDEX `call_recordings_call_idx` ON `call_recordings` (`call_id`);--> statement-breakpoint
CREATE INDEX `call_recordings_owner_created_idx` ON `call_recordings` (`owner_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `number_recording` (
	`number_id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`record_calls` integer DEFAULT false NOT NULL,
	`play_notice` integer DEFAULT false NOT NULL,
	`notice_text` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`number_id`) REFERENCES `phone_numbers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `number_recording_owner_idx` ON `number_recording` (`owner_id`);
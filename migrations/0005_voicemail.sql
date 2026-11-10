CREATE TABLE `voicemail_settings` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`retention_days` integer DEFAULT 90 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `voicemails` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`call_id` text NOT NULL,
	`number_id` text,
	`from` text NOT NULL,
	`duration` integer,
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
	`listened_at` integer,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`call_id`) REFERENCES `calls`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`number_id`) REFERENCES `phone_numbers`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `voicemails_twilio_recording_sid_unique` ON `voicemails` (`twilio_recording_sid`);--> statement-breakpoint
CREATE UNIQUE INDEX `voicemails_call_idx` ON `voicemails` (`call_id`);--> statement-breakpoint
CREATE INDEX `voicemails_owner_created_idx` ON `voicemails` (`owner_id`,`created_at`,`id`);
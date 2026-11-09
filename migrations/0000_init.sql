CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`target` text,
	`metadata` text,
	`ip` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `audit_events_owner_created_idx` ON `audit_events` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `calls` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`twilio_call_sid` text NOT NULL,
	`parent_call_sid` text,
	`direction` text NOT NULL,
	`number_id` text,
	`party` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer,
	`answered_at` integer,
	`ended_at` integer,
	`duration` integer,
	`contact_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`number_id`) REFERENCES `phone_numbers`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calls_twilio_call_sid_unique` ON `calls` (`twilio_call_sid`);--> statement-breakpoint
CREATE INDEX `calls_owner_started_idx` ON `calls` (`owner_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `calls_parent_idx` ON `calls` (`parent_call_sid`);--> statement-breakpoint
CREATE INDEX `calls_party_idx` ON `calls` (`party`);--> statement-breakpoint
CREATE TABLE `contact_numbers` (
	`id` text PRIMARY KEY NOT NULL,
	`contact_id` text NOT NULL,
	`e164` text NOT NULL,
	`label` text,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `contact_numbers_e164_idx` ON `contact_numbers` (`e164`);--> statement-breakpoint
CREATE UNIQUE INDEX `contact_numbers_contact_e164_idx` ON `contact_numbers` (`contact_id`,`e164`);--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`display_name` text NOT NULL,
	`company` text,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `contacts_owner_name_idx` ON `contacts` (`owner_id`,`display_name`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`number_id` text NOT NULL,
	`participant` text NOT NULL,
	`last_message_at` integer,
	`last_message_preview` text,
	`unread_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`number_id`) REFERENCES `phone_numbers`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_number_participant_idx` ON `conversations` (`number_id`,`participant`);--> statement-breakpoint
CREATE INDEX `conversations_owner_last_idx` ON `conversations` (`owner_id`,`last_message_at`);--> statement-breakpoint
CREATE INDEX `conversations_participant_idx` ON `conversations` (`participant`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`twilio_sid` text,
	`direction` text NOT NULL,
	`from` text NOT NULL,
	`to` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`status` text NOT NULL,
	`error_code` integer,
	`sent_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_twilio_sid_unique` ON `messages` (`twilio_sid`);--> statement-breakpoint
CREATE INDEX `messages_conversation_created_idx` ON `messages` (`conversation_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `messages_owner_created_idx` ON `messages` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `phone_numbers` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`e164` text NOT NULL,
	`twilio_sid` text NOT NULL,
	`friendly_name` text DEFAULT '' NOT NULL,
	`capabilities` text NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`released_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `phone_numbers_e164_unique` ON `phone_numbers` (`e164`);--> statement-breakpoint
CREATE UNIQUE INDEX `phone_numbers_twilio_sid_unique` ON `phone_numbers` (`twilio_sid`);--> statement-breakpoint
CREATE INDEX `phone_numbers_owner_idx` ON `phone_numbers` (`owner_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `phone_numbers_one_default_idx` ON `phone_numbers` (`owner_id`) WHERE is_default = 1;--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`user_agent` text,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint_unique` ON `push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE INDEX `push_subscriptions_owner_idx` ON `push_subscriptions` (`owner_id`);--> statement-breakpoint
CREATE TABLE `spend_events` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`kind` text NOT NULL,
	`twilio_sid` text NOT NULL,
	`price` text,
	`price_unit` text,
	`units` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `spend_events_twilio_sid_unique` ON `spend_events` (`twilio_sid`);--> statement-breakpoint
CREATE INDEX `spend_events_owner_created_idx` ON `spend_events` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `user_preferences` (
	`user_id` text PRIMARY KEY NOT NULL,
	`default_number_id` text,
	`country_allowlist` text DEFAULT '[]' NOT NULL,
	`locale` text DEFAULT 'en' NOT NULL,
	`theme` text DEFAULT 'system' NOT NULL,
	`sms_per_hour` integer DEFAULT 30 NOT NULL,
	`calls_per_hour` integer DEFAULT 20 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`default_number_id`) REFERENCES `phone_numbers`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `webhook_events` (
	`id` text PRIMARY KEY NOT NULL,
	`idempotency_key` text NOT NULL,
	`type` text NOT NULL,
	`received_at` integer NOT NULL,
	`processed_at` integer,
	`payload_hash` text NOT NULL,
	`attempts` integer DEFAULT 1 NOT NULL,
	`last_error` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_events_idempotency_key_unique` ON `webhook_events` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `webhook_events_received_idx` ON `webhook_events` (`received_at`);--> statement-breakpoint
CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_user_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE TABLE `owner_claim` (
	`id` integer PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`claimed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rate_limit` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`count` integer NOT NULL,
	`last_request` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rate_limit_key_unique` ON `rate_limit` (`key`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_user_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE INDEX `user_created_idx` ON `user` (`created_at`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer,
	`updated_at` integer
);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);
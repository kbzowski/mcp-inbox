CREATE TABLE `emails` (
	`folder` text NOT NULL,
	`uid` integer NOT NULL,
	`message_id` text,
	`subject` text,
	`from_addr` text,
	`to_addrs` text,
	`cc_addrs` text,
	`date` integer,
	`flags` text NOT NULL,
	`has_attachments` integer DEFAULT false NOT NULL,
	`envelope_json` text NOT NULL,
	`body_text` text,
	`body_html` text,
	`modseq` integer,
	`cached_at` integer NOT NULL,
	`body_cached_at` integer,
	CONSTRAINT `emails_pk` PRIMARY KEY(`folder`, `uid`)
);
--> statement-breakpoint
CREATE TABLE `folders` (
	`name` text PRIMARY KEY,
	`delimiter` text NOT NULL,
	`special_use` text,
	`uid_validity` integer NOT NULL,
	`uid_next` integer,
	`highest_modseq` integer,
	`last_synced_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_emails_date` ON `emails` (`folder`,`date`);--> statement-breakpoint
CREATE INDEX `idx_emails_message_id` ON `emails` (`message_id`);
CREATE TABLE `raw_composio_session` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`session` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `raw_composio_session_scope_id_idx` ON `raw_composio_session` (`scope_id`);--> statement-breakpoint
ALTER TABLE `raw_source` ADD `composio` text;--> statement-breakpoint
ALTER TABLE `raw_source` ADD `auth` text;
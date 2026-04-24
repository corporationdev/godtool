CREATE TABLE `raw_source` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`name` text NOT NULL,
	`base_url` text NOT NULL,
	`headers` text,
	`composio` text,
	`auth` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `raw_source_scope_id_idx` ON `raw_source` (`scope_id`);
--> statement-breakpoint
CREATE TABLE `raw_composio_session` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`session` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `raw_composio_session_scope_id_idx` ON `raw_composio_session` (`scope_id`);

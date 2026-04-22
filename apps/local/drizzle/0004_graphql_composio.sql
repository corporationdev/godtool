ALTER TABLE `graphql_source` ADD `composio` text;
--> statement-breakpoint
ALTER TABLE `graphql_source` ADD `auth` text;
--> statement-breakpoint
CREATE TABLE `graphql_composio_session` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`session` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `graphql_composio_session_scope_id_idx` ON `graphql_composio_session` (`scope_id`);

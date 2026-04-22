CREATE TABLE `google_discovery_composio_session` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`session` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `google_discovery_composio_session_scope_id_idx` ON `google_discovery_composio_session` (`scope_id`);

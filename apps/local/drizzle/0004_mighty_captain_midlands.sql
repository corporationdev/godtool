CREATE TABLE `raw_source` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`name` text NOT NULL,
	`base_url` text NOT NULL,
	`headers` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `raw_source_scope_id_idx` ON `raw_source` (`scope_id`);
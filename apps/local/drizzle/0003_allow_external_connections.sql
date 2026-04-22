CREATE TABLE `__new_connection` (
	`id` text NOT NULL,
	`scope_id` text NOT NULL,
	`provider` text NOT NULL,
	`kind` text NOT NULL,
	`identity_label` text,
	`access_token_secret_id` text,
	`refresh_token_secret_id` text,
	`expires_at` integer,
	`scope` text,
	`provider_state` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`scope_id`, `id`)
);
--> statement-breakpoint
INSERT INTO `__new_connection`(
	`id`,
	`scope_id`,
	`provider`,
	`kind`,
	`identity_label`,
	`access_token_secret_id`,
	`refresh_token_secret_id`,
	`expires_at`,
	`scope`,
	`provider_state`,
	`created_at`,
	`updated_at`
)
SELECT
	`id`,
	`scope_id`,
	`provider`,
	`kind`,
	`identity_label`,
	`access_token_secret_id`,
	`refresh_token_secret_id`,
	`expires_at`,
	`scope`,
	`provider_state`,
	`created_at`,
	`updated_at`
FROM `connection`;
--> statement-breakpoint
DROP TABLE `connection`;
--> statement-breakpoint
ALTER TABLE `__new_connection` RENAME TO `connection`;
--> statement-breakpoint
CREATE INDEX `connection_scope_id_idx` ON `connection` (`scope_id`);
--> statement-breakpoint
CREATE INDEX `connection_provider_idx` ON `connection` (`provider`);

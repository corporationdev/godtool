CREATE TABLE "raw_source" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"headers" jsonb,
	"composio" jsonb,
	"auth" jsonb,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "raw_source_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
CREATE INDEX "raw_source_scope_id_idx" ON "raw_source" USING btree ("scope_id");
--> statement-breakpoint
CREATE TABLE "raw_composio_session" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"session" jsonb NOT NULL,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "raw_composio_session_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
CREATE INDEX "raw_composio_session_scope_id_idx" ON "raw_composio_session" USING btree ("scope_id");

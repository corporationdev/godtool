CREATE TABLE "raw_composio_session" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"session" jsonb NOT NULL,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "raw_composio_session_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
CREATE INDEX "raw_composio_session_scope_id_idx" ON "raw_composio_session" USING btree ("scope_id");
--> statement-breakpoint
ALTER TABLE "raw_source" ADD COLUMN "composio" jsonb;
--> statement-breakpoint
ALTER TABLE "raw_source" ADD COLUMN "auth" jsonb;

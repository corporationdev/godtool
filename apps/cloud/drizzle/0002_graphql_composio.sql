ALTER TABLE "graphql_source"
ADD COLUMN "composio" jsonb,
ADD COLUMN "auth" jsonb;
--> statement-breakpoint
CREATE TABLE "graphql_composio_session" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"session" jsonb NOT NULL,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "graphql_composio_session_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
CREATE INDEX "graphql_composio_session_scope_id_idx" ON "graphql_composio_session" USING btree ("scope_id");

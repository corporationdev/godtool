CREATE TABLE "google_discovery_source" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"name" text NOT NULL,
	"config" jsonb NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "google_discovery_source_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
CREATE TABLE "google_discovery_binding" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"source_id" text NOT NULL,
	"binding" jsonb NOT NULL,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "google_discovery_binding_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
CREATE TABLE "google_discovery_oauth_session" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"session" jsonb NOT NULL,
	"expires_at" timestamp NOT NULL,
	CONSTRAINT "google_discovery_oauth_session_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
CREATE TABLE "raw_source" (
	"id" text NOT NULL,
	"scope_id" text NOT NULL,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"headers" jsonb,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "raw_source_scope_id_id_pk" PRIMARY KEY("scope_id","id")
);
--> statement-breakpoint
CREATE INDEX "google_discovery_source_scope_id_idx" ON "google_discovery_source" USING btree ("scope_id");
--> statement-breakpoint
CREATE INDEX "google_discovery_binding_scope_id_idx" ON "google_discovery_binding" USING btree ("scope_id");
--> statement-breakpoint
CREATE INDEX "google_discovery_binding_source_id_idx" ON "google_discovery_binding" USING btree ("source_id");
--> statement-breakpoint
CREATE INDEX "google_discovery_oauth_session_scope_id_idx" ON "google_discovery_oauth_session" USING btree ("scope_id");
--> statement-breakpoint
CREATE INDEX "raw_source_scope_id_idx" ON "raw_source" USING btree ("scope_id");

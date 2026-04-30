CREATE TABLE "source_catalog" (
  "organization_id" text NOT NULL,
  "device_id" text NOT NULL,
  "source_id" text NOT NULL,
  "plugin_id" text NOT NULL,
  "kind" text NOT NULL,
  "name" text NOT NULL,
  "tool_count" integer DEFAULT 0 NOT NULL,
  "local_available" boolean DEFAULT false NOT NULL,
  "remote_available" boolean DEFAULT false NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "source_catalog_organization_id_device_id_source_id_pk" PRIMARY KEY("organization_id","device_id","source_id")
);
--> statement-breakpoint
ALTER TABLE "source_catalog" ADD CONSTRAINT "source_catalog_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;

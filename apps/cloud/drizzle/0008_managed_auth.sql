ALTER TABLE "openapi_source" ADD COLUMN "managed_auth" jsonb;--> statement-breakpoint
ALTER TABLE "graphql_source" ADD COLUMN "managed_auth" jsonb;--> statement-breakpoint
ALTER TABLE "raw_source" ADD COLUMN "managed_auth" jsonb;

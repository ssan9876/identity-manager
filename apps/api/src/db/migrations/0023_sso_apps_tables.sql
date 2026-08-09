CREATE TYPE "public"."sso_app_protocol" AS ENUM('openid-connect');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "external_sso_app_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"system" "external_identity_system" NOT NULL,
	"external_id" varchar(255) NOT NULL,
	"last_synced_at" timestamp with time zone,
	"sync_state" "external_identity_sync_state" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sso_apps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"protocol" "sso_app_protocol" DEFAULT 'openid-connect' NOT NULL,
	"public_client" boolean NOT NULL,
	"redirect_uris" text[] NOT NULL,
	"web_origins" text[] NOT NULL,
	"groups_claim" boolean DEFAULT true NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "external_sso_app_identities" ADD CONSTRAINT "external_sso_app_identities_app_id_sso_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."sso_apps"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "external_sso_app_identities_app_system_unique" ON "external_sso_app_identities" USING btree ("app_id","system");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sso_apps_client_id_unique" ON "sso_apps" USING btree ("client_id");
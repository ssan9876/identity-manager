CREATE TYPE "public"."external_identity_sync_state" AS ENUM('pending', 'synced', 'failed');--> statement-breakpoint
CREATE TYPE "public"."external_identity_system" AS ENUM('keycloak', 'active_directory', 'google_workspace');--> statement-breakpoint
CREATE TYPE "public"."outbox_aggregate_type" AS ENUM('user', 'group', 'membership', 'org_unit');--> statement-breakpoint
CREATE TYPE "public"."outbox_event_type" AS ENUM('created', 'updated', 'status_changed', 'membership_changed');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('pending', 'processing', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."outbox_target" AS ENUM('keycloak');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "external_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"system" "external_identity_system" NOT NULL,
	"external_id" varchar(255) NOT NULL,
	"last_synced_at" timestamp with time zone,
	"sync_state" "external_identity_sync_state" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "outbox_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"aggregate_type" "outbox_aggregate_type" NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"event_type" "outbox_event_type" NOT NULL,
	"payload" jsonb NOT NULL,
	"target" "outbox_target" DEFAULT 'keycloak' NOT NULL,
	"status" "outbox_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "external_identities" ADD CONSTRAINT "external_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "external_identities_user_system_unique" ON "external_identities" USING btree ("user_id","system");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outbox_events_status_next_attempt_idx" ON "outbox_events" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outbox_events_aggregate_idx" ON "outbox_events" USING btree ("aggregate_type","aggregate_id","id");
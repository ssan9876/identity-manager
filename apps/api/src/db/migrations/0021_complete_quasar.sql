CREATE TYPE "public"."provisioning_mode" AS ENUM('all_users', 'entitled_only');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_target_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"target" "outbox_target" NOT NULL,
	"grant_source" "grant_source" DEFAULT 'manual' NOT NULL,
	"granted_by" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connector_targets" ADD COLUMN "provisioning_mode" "provisioning_mode" DEFAULT 'all_users' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_target_accounts" ADD CONSTRAINT "user_target_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_target_accounts" ADD CONSTRAINT "user_target_accounts_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_target_accounts_unique" ON "user_target_accounts" USING btree ("user_id","target");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_target_accounts_target_idx" ON "user_target_accounts" USING btree ("target","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_target_accounts_source_idx" ON "user_target_accounts" USING btree ("grant_source","user_id");
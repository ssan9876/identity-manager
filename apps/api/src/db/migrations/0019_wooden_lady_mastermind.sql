CREATE TYPE "public"."grant_source" AS ENUM('business_role', 'manual');--> statement-breakpoint
ALTER TABLE "group_user_members" ADD COLUMN "grant_source" "grant_source" DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "group_user_members" ADD COLUMN "granted_by" uuid;--> statement-breakpoint
ALTER TABLE "group_user_members" ADD COLUMN "granted_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "group_user_members" ADD CONSTRAINT "group_user_members_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "group_user_members_source_idx" ON "group_user_members" USING btree ("grant_source","user_id");
CREATE TYPE "public"."role_key" AS ENUM('super_admin', 'user_admin', 'help_desk', 'auditor', 'read_only');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "role_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"role_key" "role_key" NOT NULL,
	"scope_org_unit_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_scope_org_unit_id_org_units_id_fk" FOREIGN KEY ("scope_org_unit_id") REFERENCES "public"."org_units"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "role_assignments_user_idx" ON "role_assignments" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "role_assignments_scoped_unique" ON "role_assignments" USING btree ("user_id","role_key","scope_org_unit_id") WHERE "role_assignments"."scope_org_unit_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "role_assignments_global_unique" ON "role_assignments" USING btree ("user_id","role_key") WHERE "role_assignments"."scope_org_unit_id" IS NULL;
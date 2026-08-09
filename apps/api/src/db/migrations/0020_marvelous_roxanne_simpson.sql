CREATE TYPE "public"."business_role_condition_operator" AS ENUM('equals', 'not_equals', 'in', 'in_org_subtree');--> statement-breakpoint
CREATE TYPE "public"."business_role_exception_mode" AS ENUM('include', 'exclude');--> statement-breakpoint
CREATE TYPE "public"."business_role_grant_kind" AS ENUM('group_membership', 'target_account');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "business_role_conditions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_role_id" uuid NOT NULL,
	"field" varchar(128) NOT NULL,
	"operator" "business_role_condition_operator" NOT NULL,
	"value" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "business_role_exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_role_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"mode" "business_role_exception_mode" NOT NULL,
	"reason" text NOT NULL,
	"expires_at" timestamp with time zone,
	"granted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "business_role_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_role_id" uuid NOT NULL,
	"kind" "business_role_grant_kind" NOT NULL,
	"group_id" uuid,
	"target" "outbox_target",
	CONSTRAINT "business_role_grants_kind_matches_reference" CHECK (("business_role_grants"."kind" = 'group_membership' AND "business_role_grants"."group_id" IS NOT NULL AND "business_role_grants"."target" IS NULL)
       OR ("business_role_grants"."kind" = 'target_account'   AND "business_role_grants"."target"  IS NOT NULL AND "business_role_grants"."group_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "business_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"draft_definition" jsonb,
	"simulated_at" timestamp with time zone,
	"simulated_draft_hash" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "business_role_conditions" ADD CONSTRAINT "business_role_conditions_business_role_id_business_roles_id_fk" FOREIGN KEY ("business_role_id") REFERENCES "public"."business_roles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "business_role_exceptions" ADD CONSTRAINT "business_role_exceptions_business_role_id_business_roles_id_fk" FOREIGN KEY ("business_role_id") REFERENCES "public"."business_roles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "business_role_exceptions" ADD CONSTRAINT "business_role_exceptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "business_role_exceptions" ADD CONSTRAINT "business_role_exceptions_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "business_role_grants" ADD CONSTRAINT "business_role_grants_business_role_id_business_roles_id_fk" FOREIGN KEY ("business_role_id") REFERENCES "public"."business_roles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "business_role_grants" ADD CONSTRAINT "business_role_grants_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "business_role_conditions_role_idx" ON "business_role_conditions" USING btree ("business_role_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "business_role_exceptions_unique" ON "business_role_exceptions" USING btree ("business_role_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "business_role_exceptions_user_idx" ON "business_role_exceptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "business_role_grants_role_idx" ON "business_role_grants" USING btree ("business_role_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "business_role_grants_unique_group" ON "business_role_grants" USING btree ("business_role_id","group_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "business_role_grants_unique_target" ON "business_role_grants" USING btree ("business_role_id","target");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "business_roles_name_idx" ON "business_roles" USING btree ("name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "business_roles_enabled_idx" ON "business_roles" USING btree ("enabled");
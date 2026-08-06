CREATE TYPE "public"."jml_action" AS ENUM('add_to_group', 'remove_from_group', 'set_attribute', 'deactivate');--> statement-breakpoint
CREATE TYPE "public"."jml_condition_operator" AS ENUM('equals', 'not_equals', 'in');--> statement-breakpoint
CREATE TYPE "public"."jml_trigger" AS ENUM('user_created', 'user_attribute_changed', 'start_date_reached', 'end_date_reached');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "jml_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"trigger" "jml_trigger" NOT NULL,
	"condition_field" varchar(128) NOT NULL,
	"condition_operator" "jml_condition_operator" NOT NULL,
	"condition_value" jsonb,
	"action" "jml_action" NOT NULL,
	"action_params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"simulated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jml_rules_enabled_trigger_idx" ON "jml_rules" USING btree ("enabled","trigger");
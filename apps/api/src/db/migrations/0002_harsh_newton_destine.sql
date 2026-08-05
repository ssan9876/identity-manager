CREATE TYPE "public"."attribute_applies_to" AS ENUM('user', 'group');--> statement-breakpoint
CREATE TYPE "public"."attribute_data_type" AS ENUM('string', 'number', 'boolean', 'date', 'enum');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "attribute_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(64) NOT NULL,
	"label" varchar(255) NOT NULL,
	"data_type" "attribute_data_type" NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"default_value" jsonb,
	"validation_rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"applies_to" "attribute_applies_to" DEFAULT 'user' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sync_to_keycloak" boolean DEFAULT false NOT NULL,
	"self_editable" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "attribute_definitions_key_scope_unique" ON "attribute_definitions" USING btree ("key","applies_to");
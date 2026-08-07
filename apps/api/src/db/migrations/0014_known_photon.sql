CREATE TYPE "public"."attribute_core_field" AS ENUM('given_name', 'surname', 'title', 'department');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "attribute_target_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attribute_definition_id" uuid,
	"core_field" "attribute_core_field",
	"target" "outbox_target" NOT NULL,
	"remote_name" varchar(255) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attribute_target_mappings_exactly_one_source" CHECK (("attribute_target_mappings"."attribute_definition_id" IS NULL) <> ("attribute_target_mappings"."core_field" IS NULL))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "attribute_target_mappings" ADD CONSTRAINT "attribute_target_mappings_attribute_definition_id_attribute_definitions_id_fk" FOREIGN KEY ("attribute_definition_id") REFERENCES "public"."attribute_definitions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "attribute_target_mappings_attribute_target_unique" ON "attribute_target_mappings" USING btree ("attribute_definition_id","target") WHERE "attribute_target_mappings"."attribute_definition_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "attribute_target_mappings_core_field_target_unique" ON "attribute_target_mappings" USING btree ("core_field","target") WHERE "attribute_target_mappings"."core_field" IS NOT NULL;--> statement-breakpoint
-- Milestone 10, Task 3 data migration — MUST run in this exact position:
-- after "attribute_target_mappings" exists (above) and before
-- "sync_to_keycloak" is dropped (below), since it reads the old column to
-- populate the new table. Hand-added; drizzle-kit generates schema DDL only,
-- never data migrations.
--
-- Every row that had `sync_to_keycloak = true` — regardless of
-- `is_active`/`applies_to`, exactly mirroring what the boolean itself never
-- filtered on either — becomes exactly one `('keycloak', <its own key>,
-- true)` mapping. `remote_name = key` is what makes this migration
-- behaviour-preserving rather than merely data-preserving: `buildTargetAttributes`
-- (connectors/attribute-mapping.ts) emits its output keyed by `remote_name`,
-- so a migrated row reproduces the EXACT key Keycloak already received
-- pre-migration, not a renamed one. A row with `sync_to_keycloak = false`
-- (the default) produces NO mapping row at all — the same "absence, not a
-- false value" default-deny shape the new table's own doc comment commits
-- to structurally.
--
-- The migrated set is proven EXACTLY equal to the previously-syncing set
-- (no more, no fewer) by
-- test/attribute-target-mapping-migration.spec.ts, which runs this literal
-- migration file against realistic pre-migration fixture data — see
-- task-3-report.md for the before/after comparison this produces.
INSERT INTO "attribute_target_mappings" ("attribute_definition_id", "target", "remote_name", "enabled")
SELECT "id", 'keycloak', "key", true FROM "attribute_definitions" WHERE "sync_to_keycloak" = true;
--> statement-breakpoint
ALTER TABLE "attribute_definitions" DROP COLUMN IF EXISTS "sync_to_keycloak";
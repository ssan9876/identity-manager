-- Master adoption: every pre-existing org unit, user and group is adopted
-- into a single "master" organization, and audit_log gains the (nullable)
-- column that will eventually attribute historical rows.
--
-- Hand-written, not drizzle-kit generated: the backfill (INSERT the master
-- row, UPDATE existing rows before the column can go NOT NULL) is data
-- migration drizzle-kit cannot know how to write. The end schema state below
-- — column types, FK constraint names, index names — matches exactly what
-- `db:generate` would have produced from the Drizzle schema changes in this
-- same commit (confirmed by generating it once to check, then replacing the
-- generated ALTER-only body with this backfill-aware sequence — see
-- task-2-report.md).

-- The master organization. `realm` stays NULL until first startup resolves
-- KEYCLOAK_ISSUER into it (see master-organization.ts) — the CHECK added in
-- the previous migration permits that for master alone.
INSERT INTO "organizations" ("slug", "name", "realm", "status", "is_master")
VALUES ('master', 'Master', NULL, 'active', true);
--> statement-breakpoint

ALTER TABLE "org_units" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "organization_id" uuid;--> statement-breakpoint

UPDATE "org_units" SET "organization_id" = (SELECT "id" FROM "organizations" WHERE "is_master");--> statement-breakpoint
UPDATE "users" SET "organization_id" = (SELECT "id" FROM "organizations" WHERE "is_master");--> statement-breakpoint
UPDATE "groups" SET "organization_id" = (SELECT "id" FROM "organizations" WHERE "is_master");--> statement-breakpoint
-- audit_log is deliberately left NULL: existing rows predate organizations,
-- and platform-level actions legitimately have none. It is also append-only
-- (enforced by both a trigger and role privileges — db/migrate.ts,
-- db/roles.ts), so this is the one and only write those rows will ever
-- receive. Adding the column above is DDL (ALTER TABLE), which the
-- append-only triggers — defined BEFORE UPDATE/DELETE/TRUNCATE, not DDL —
-- never intercept.

ALTER TABLE "org_units" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "groups" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "org_units" ADD CONSTRAINT "org_units_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "users" ADD CONSTRAINT "users_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "groups" ADD CONSTRAINT "groups_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "org_units_organization_idx" ON "org_units" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_organization_idx" ON "users" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "groups_organization_idx" ON "groups" USING btree ("organization_id");

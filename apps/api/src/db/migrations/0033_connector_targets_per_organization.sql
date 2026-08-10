-- Milestone: organizations multi-tenancy — per-organization connector
-- targets. `connector_targets` was keyed by `target` alone, so there was
-- exactly ONE Active Directory configuration, one Entra, one Google and one
-- mail-server configuration for the whole system — all belonging to whoever
-- runs the platform. That is why `OutboxWriter.record` had to hard-code
-- "a tenant reaches keycloak and nothing else": fanning a tenant into the
-- shared AD would create real accounts in somebody ELSE's estate. This
-- migration makes the table's identity (organization_id, target), so each
-- organization owns its own catalog of configured targets, and an
-- organization with no row for a target simply does not fan out to it —
-- absence means "not configured", never "fall back to another org's config".
--
-- EXISTING ROWS BELONG TO MASTER. Every row in this table today was written
-- by, and for, the platform operator — the same backfill posture 0025 took
-- for users/groups/org units. The backfill below derives master via
-- `is_master`, the one row `organizations_master_unique` guarantees.
--
-- THE DEFAULT IS A FUNCTION, deliberately. `master_organization_id()` gives
-- the column a DB-level default of "the master organization" — a value that
-- cannot be a literal in a migration because master's uuid differs per
-- database. This preserves the meaning of every pre-existing INSERT that
-- names no organization (test fixtures, operator SQL): such a write lands in
-- MASTER, exactly where every row it could previously create conceptually
-- lived. This is a WRITE-time convenience only — no READ path anywhere
-- falls back across organizations; resolution is always by the exact
-- (organization_id, target) pair.
--
-- Hand-written rather than generator output, like 0029, because the
-- generator cannot order "add NOT NULL column on a populated table" around
-- a backfill, and cannot express the function-valued default at all.
--
-- Every step below is RE-RUNNABLE: test/migrate.spec.ts rewinds the ledger
-- to 0027's journal `when` and replays this whole tail against a POPULATED
-- schema, so a second pass must not error. `IF NOT EXISTS`, `CREATE OR
-- REPLACE`, and the duplicate_object guard (the shape 0025/0029 already
-- use) keep that honest. Note the PK swap replays cleanly too: DROP
-- CONSTRAINT IF EXISTS followed by re-ADD is safe because nothing holds a
-- foreign key INTO connector_targets.

-- ---------------------------------------------------------------------------
-- 1. The write-time default: "the master organization".
-- STABLE, not IMMUTABLE — it reads a table — and safe as a column default
-- (evaluated per insert). Master always exists from 0025 onward, and
-- `organizations_master_unique` guarantees at most one row matches.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION master_organization_id() RETURNS uuid
LANGUAGE sql STABLE AS
$fn$ SELECT id FROM organizations WHERE is_master $fn$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. The column: added nullable, backfilled to master, then pinned NOT NULL
-- with the function default — the same three-step shape 0025/0029 used for
-- exactly the same "populated table" reason.
-- ---------------------------------------------------------------------------
ALTER TABLE "connector_targets" ADD COLUMN IF NOT EXISTS "organization_id" uuid;--> statement-breakpoint
UPDATE "connector_targets" SET "organization_id" = master_organization_id() WHERE "organization_id" IS NULL;--> statement-breakpoint
ALTER TABLE "connector_targets" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_targets" ALTER COLUMN "organization_id" SET DEFAULT master_organization_id();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. The identity swap: (organization_id, target) IS the primary key.
-- The old single-column PK ("target" alone) is what made a second AD
-- configuration unrepresentable; dropping it and re-adding the composite
-- under the SAME name keeps every ON CONFLICT that names the constraint's
-- columns honest. Droppable safely: no table references connector_targets.
-- ---------------------------------------------------------------------------
ALTER TABLE "connector_targets" DROP CONSTRAINT IF EXISTS "connector_targets_pkey";--> statement-breakpoint
ALTER TABLE "connector_targets" ADD CONSTRAINT "connector_targets_pkey" PRIMARY KEY ("organization_id", "target");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. The tenancy FK. A single-column FK is the correct shape HERE — unlike
-- the 0029 edges, this row's `organization_id` is not pairing two other
-- rows that could disagree about their tenant; it IS the row's tenant, and
-- referencing `organizations(id)` directly is the whole constraint. No ON
-- DELETE action: organizations are never deleted (nothing in this system
-- is), so a delete failing loudly is the correct outcome.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  ALTER TABLE "connector_targets" ADD CONSTRAINT "connector_targets_organization_id_organizations_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

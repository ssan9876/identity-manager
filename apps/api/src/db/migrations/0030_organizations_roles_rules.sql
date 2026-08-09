-- Milestone: organizations multi-tenancy, Task 5 — business roles and JML
-- rules belong to an organization.
--
-- These are the last two tables that decide WHO GETS WHAT and still had no
-- tenant. A business role is a membership formula plus a set of
-- entitlements; a JML rule is a trigger plus an action taken against a
-- person. Both are evaluated against every user the engine can see, so an
-- untenanted role is, the moment a second organization exists, a formula
-- one tenant's admin writes that silently grants (or deactivates) inside
-- another tenant's directory.
--
-- The plan's own note for this task — "nothing reads business_roles yet,
-- which is exactly why the column goes in now" — is STALE: Milestone 17
-- landed the reconciler (runs on every user write) and the sweep job (walks
-- every user) before this task ran. The column therefore arrives alongside
-- the query change that makes evaluation organization-scoped; see
-- BusinessRolesRepository.listEnabledForEvaluation and
-- JmlRulesRepository.listEnabledByTrigger, both of which now REQUIRE the
-- organization to filter by rather than accepting an optional one a caller
-- can forget.
--
-- The three child tables of `business_roles` (conditions, grants,
-- exceptions) deliberately get NO column: they reach their organization
-- through their parent, and a second copy would be a second thing to keep
-- in step. What that leaves unguarded — a grant pointing at a group in
-- ANOTHER organization — is not left unguarded in practice: the membership
-- edge the reconciler would have to write carries organization_id from the
-- GROUP and is pinned to the user by `gum_user_organization_fk` (0029), so
-- the cross-tenant write fails at the database. A composite FK from
-- `business_role_grants` to `groups(id, organization_id)` would move that
-- rejection earlier, to the moment a role is published rather than the
-- moment it is applied; it is deliberately deferred to Task 12, which is
-- where a second organization first becomes creatable and where the
-- publish path grows an organization to check against.
--
-- RE-RUNNABLE, like everything from 0027 onward: test/migrate.spec.ts
-- rewinds the ledger to 0027's journal `when` and replays this whole tail
-- against a POPULATED schema. `ADD COLUMN IF NOT EXISTS`, an idempotent
-- backfill guarded on `IS NULL`, `CREATE INDEX IF NOT EXISTS` and
-- duplicate_object guards on the constraints are what keep that honest —
-- 0025 and 0029 are the models.

-- ---------------------------------------------------------------------------
-- 1. The column: added nullable, backfilled, then made NOT NULL.
--
-- The three-step shape (rather than a single NOT NULL add) is the one 0025
-- and 0029 already use, and it is the only shape that can run against a
-- populated table: every pre-existing role and rule predates organizations
-- entirely, so there is no value for a NOT NULL default to take other than
-- the one this backfill computes.
--
-- Master is the correct destination for every existing row by construction:
-- 0025 adopted every pre-existing org unit, user and group into it, so the
-- population these rules were written against is master's population.
-- ---------------------------------------------------------------------------
ALTER TABLE "business_roles" ADD COLUMN IF NOT EXISTS "organization_id" uuid;--> statement-breakpoint
ALTER TABLE "jml_rules"      ADD COLUMN IF NOT EXISTS "organization_id" uuid;--> statement-breakpoint

UPDATE "business_roles" SET "organization_id" = (SELECT "id" FROM "organizations" WHERE "is_master")
  WHERE "organization_id" IS NULL;--> statement-breakpoint
UPDATE "jml_rules" SET "organization_id" = (SELECT "id" FROM "organizations" WHERE "is_master")
  WHERE "organization_id" IS NULL;--> statement-breakpoint

ALTER TABLE "business_roles" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "jml_rules"      ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. ON DELETE RESTRICT, matching org_units/users/groups (0025).
--
-- An organization can never be deleted out from under the rules that decide
-- its access. CASCADE would be worse than a failed delete: it would remove
-- the formulas while leaving every entitlement they had already granted in
-- place, with nothing left to explain or revoke them.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
 ALTER TABLE "business_roles" ADD CONSTRAINT "business_roles_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "jml_rules" ADD CONSTRAINT "jml_rules_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Role names become unique PER ORGANIZATION, exactly as 0028 did for
--    users.username/primary_email/employee_id and groups.name.
--
-- A global unique name means whichever tenant onboards "Engineering
-- Standard Access" first permanently denies that name to every other
-- tenant, and the 409 that denies it is an existence oracle across the
-- tenant boundary.
--
-- The index NAME is deliberately unchanged: BusinessRolesRepository.
-- translateWriteError matches the string `business_roles_name_idx` to turn
-- a 23505 into a ConflictError, and renaming it would silently turn a 409
-- into a 500 with no test necessarily noticing (0028's note, verbatim, for
-- the same reason).
--
-- Safe on an existing database: the new key is strictly WEAKER than the old
-- one, since every existing row is in master, so it cannot fail to build on
-- data that already satisfied the global key.
--
-- Unlike 0028 this is NOT case-folded, because the index it replaces was
-- not either — `business_roles_name_idx` has always been a plain btree on
-- `name`. Making role names case-insensitive is a behaviour change that
-- belongs to whoever wants it, not to a tenancy migration.
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS "business_roles_name_idx";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "business_roles_name_idx" ON "business_roles" USING btree ("organization_id","name");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. The reads these columns exist to serve.
--
-- `listEnabledForEvaluation` is the reconciler's hot read and now filters on
-- (organization_id, enabled); `listEnabledByTrigger` is the lifecycle job's
-- and now filters on (organization_id, enabled, trigger). Both existing
-- indexes are re-created with organization_id LEADING rather than a third
-- index being added beside them: the tenant is the first discriminator once
-- more than one exists, and an index that no query leads with is pure write
-- cost. The NAMES are kept for the same reason 0028 kept its own — nothing
-- in code matches on these two, but keeping the naming stable is what makes
-- the next reader able to find them from the snapshot history.
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS "business_roles_enabled_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "business_roles_enabled_idx" ON "business_roles" USING btree ("organization_id","enabled");--> statement-breakpoint
DROP INDEX IF EXISTS "jml_rules_enabled_trigger_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jml_rules_enabled_trigger_idx" ON "jml_rules" USING btree ("organization_id","enabled","trigger");

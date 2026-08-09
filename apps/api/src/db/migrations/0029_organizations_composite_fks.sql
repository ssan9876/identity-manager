-- Milestone: organizations multi-tenancy, Task 4 — cross-tenant references
-- made impossible.
--
-- Task 2 gave every org unit, user and group an organization_id, and Task 3
-- scoped uniqueness to it. Neither stops a row in one organization from
-- POINTING AT a row in another: today `organization_id` is derived from the
-- org unit at write time, so application code cannot produce a mismatch —
-- but a CSV import, a connector write-back, a reconciler, a future endpoint
-- or a plain bug could, and the failure mode is one tenant reading or
-- granting into another tenant's directory. That belongs in the database,
-- where nothing can route around it.
--
-- Every reference therefore becomes a COMPOSITE foreign key carrying
-- organization_id on both sides. The single-column FKs are deliberately
-- LEFT IN PLACE alongside these: `translateWriteError` in the users and
-- groups repositories matches on their exact names
-- (`users_org_unit_id_org_units_id_fk`, `users_manager_id_users_id_fk`) to
-- turn a 23503 into a 404/422, and dropping them would silently turn those
-- into 500s.
--
-- Hand-written rather than taken verbatim from drizzle-kit, which emitted
-- the same end state in an order that cannot run on a populated database:
--   1. it adds the edge tables' organization_id as NOT NULL in one step,
--      with no backfill — every existing membership row would violate it;
--   2. it adds the composite FKs BEFORE creating the unique indexes they
--      reference, which errors with "there is no unique constraint matching
--      given keys";
--   3. it writes the manager FK as a bare `ON DELETE set null`. See the
--      note on that constraint below for why that one is not survivable.
--
-- Every step below is written to be RE-RUNNABLE. Drizzle only applies a
-- migration whose journal `when` exceeds the newest `created_at` in its
-- ledger, so this never re-runs in production — but test/migrate.spec.ts
-- deliberately rewinds that ledger to prove 0027's guard fires, which
-- re-runs everything after 0027 as well. `IF NOT EXISTS` and the
-- duplicate_object guards (the shape 0025 already uses) keep that honest.
-- The resulting SCHEMA is identical to what `db:generate` produces from the
-- Drizzle schema in this same commit (the drift check is clean), with the
-- single documented exception of the manager FK's column list.

-- ---------------------------------------------------------------------------
-- 1. Referenceable targets.
--
-- A composite FK can only reference a UNIQUE key over exactly the referenced
-- pair. `id` being a unique primary key on its own is not enough — Postgres
-- requires a constraint/index on the (id, organization_id) pair itself.
-- These are strictly redundant as uniqueness (id alone already implies it);
-- they exist only to be referenceable.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS "org_units_id_organization_key" ON "org_units" USING btree ("id","organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_id_organization_key" ON "users" USING btree ("id","organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "groups_id_organization_key" ON "groups" USING btree ("id","organization_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. The membership edges carry the organization themselves.
--
-- An edge table is the one place a cross-tenant reference can hide in plain
-- sight: both endpoints are individually valid rows and only the PAIR is
-- wrong, so no single-column FK can see it. Putting organization_id on the
-- EDGE and pinning both endpoints to it makes the wrong pair
-- unrepresentable — there is no value that satisfies both sides when the
-- endpoints disagree.
--
-- Backfilled from the GROUP, never from the user: after 0025 every row is in
-- master anyway, so the two agree today, but the group is the correct source
-- of truth for the general case (a platform operator in master may act on
-- another tenant's group, and the edge belongs to the tenant that owns the
-- group). Added nullable, backfilled, then set NOT NULL — the same
-- three-step shape 0025 used, and the reason this file is hand-written.
-- ---------------------------------------------------------------------------
ALTER TABLE "group_user_members" ADD COLUMN IF NOT EXISTS "organization_id" uuid;--> statement-breakpoint
UPDATE "group_user_members" m SET "organization_id" = g."organization_id"
  FROM "groups" g WHERE g."id" = m."group_id";--> statement-breakpoint
ALTER TABLE "group_user_members" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "group_group_members" ADD COLUMN IF NOT EXISTS "organization_id" uuid;--> statement-breakpoint
UPDATE "group_group_members" m SET "organization_id" = g."organization_id"
  FROM "groups" g WHERE g."id" = m."parent_group_id";--> statement-breakpoint
ALTER TABLE "group_group_members" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. The constraints.
--
-- MATCH SIMPLE (the default) is what makes the nullable references work: a
-- NULL in any column of the referencing pair satisfies the constraint
-- outright. That is the wanted behaviour for a root org unit (no parent), a
-- global group (no org unit) and the great majority of users (no manager
-- recorded) — none of which can be cross-tenant, because they point at
-- nothing at all.
-- ---------------------------------------------------------------------------

-- A user's org unit must be in the user's own organization.
DO $$ BEGIN
 ALTER TABLE "users" ADD CONSTRAINT "users_org_unit_organization_fk"
  FOREIGN KEY ("org_unit_id","organization_id")
  REFERENCES "public"."org_units"("id","organization_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

-- A user's manager likewise.
--
-- `SET NULL (manager_id)` — the COLUMN LIST form, Postgres 15+ — is
-- load-bearing, not a stylistic choice. organization_id is NOT NULL, so a
-- bare `SET NULL` would try to null it as well and EVERY manager deletion
-- would fail with a not-null violation, where
-- `users_manager_id_users_id_fk` has always just orphaned the report. Many
-- spec files do a blanket `DELETE FROM users` between tests, so getting this
-- wrong fails the suite in a way that looks nothing like a tenancy bug.
-- Drizzle's `onDelete('set null')` cannot express the column list; this is
-- the one documented place where this file's SQL is deliberately narrower
-- than the schema declaration, and the real behaviour is pinned by
-- test/organizations.isolation.spec.ts.
DO $$ BEGIN
 ALTER TABLE "users" ADD CONSTRAINT "users_manager_organization_fk"
  FOREIGN KEY ("manager_id","organization_id")
  REFERENCES "public"."users"("id","organization_id") ON DELETE SET NULL ("manager_id") ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

-- A group's org unit. NULL org_unit_id means a global group and passes.
DO $$ BEGIN
 ALTER TABLE "groups" ADD CONSTRAINT "groups_org_unit_organization_fk"
  FOREIGN KEY ("org_unit_id","organization_id")
  REFERENCES "public"."org_units"("id","organization_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

-- An org unit's parent. A mis-set parent_id would otherwise graft one
-- tenant's whole subtree under another's, and because scope filtering is
-- path-based every ancestor-scoped read would then cross the boundary.
DO $$ BEGIN
 ALTER TABLE "org_units" ADD CONSTRAINT "org_units_parent_organization_fk"
  FOREIGN KEY ("parent_id","organization_id")
  REFERENCES "public"."org_units"("id","organization_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

-- The edges' own organization, plus both endpoints pinned to it. CASCADE
-- matches the single-column FKs these sit alongside: deleting a group or a
-- user has always removed its membership rows, and a composite FK with a
-- different action would quietly change that.
DO $$ BEGIN
 ALTER TABLE "group_user_members" ADD CONSTRAINT "group_user_members_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "group_user_members" ADD CONSTRAINT "gum_group_organization_fk"
  FOREIGN KEY ("group_id","organization_id")
  REFERENCES "public"."groups"("id","organization_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "group_user_members" ADD CONSTRAINT "gum_user_organization_fk"
  FOREIGN KEY ("user_id","organization_id")
  REFERENCES "public"."users"("id","organization_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

-- Nesting cannot cross a tenant boundary either — a nested group grants its
-- parent's members everything the child grants, so one cross-tenant edge
-- here is a silent privilege bridge between two tenants.
DO $$ BEGIN
 ALTER TABLE "group_group_members" ADD CONSTRAINT "group_group_members_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "group_group_members" ADD CONSTRAINT "ggm_parent_organization_fk"
  FOREIGN KEY ("parent_group_id","organization_id")
  REFERENCES "public"."groups"("id","organization_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "group_group_members" ADD CONSTRAINT "ggm_child_organization_fk"
  FOREIGN KEY ("child_group_id","organization_id")
  REFERENCES "public"."groups"("id","organization_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

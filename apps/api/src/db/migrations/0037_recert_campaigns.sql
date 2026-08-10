-- Recertification, migration 1 of 2 — the campaign frame.
--
-- An access-recertification campaign over business-role entitlements: the
-- governance layer the business-roles design (docs/archive/specs/
-- 2026-08-08-business-roles-entitlements-design.md) named as its own
-- dependent. The campaign row carries only the FRAME — what to review,
-- who reviews it, by when; the review set itself is snapshotted into
-- `recert_items` (0038) at open time.
--
-- `reviewer_strategy` is a CLOSED vocabulary held as DATA, never code —
-- the same posture as jml_trigger/jml_action: application code interprets
-- the value through an allowlisted dispatch and refuses one it does not
-- recognise, rather than trusting compile-time enum typing.
--
-- `status` is draft → open → closed with `closed` terminal, enforced by a
-- repository allow-list exactly as users.status transitions are. There is
-- NO DELETE: a campaign is a record of a review that happened.
--
-- RE-RUNNABLE, like everything from 0027 onward: test/migrate.spec.ts
-- rewinds the ledger and replays this tail against a populated schema, so
-- the types take duplicate_object guards and every CREATE takes IF NOT
-- EXISTS — 0029 and 0030 are the models. The enums are CREATEd and USED in
-- this same migration, which is safe: the "never use an enum value in the
-- same migration that adds it" rule (13-development.md) is about ALTER TYPE
-- ADD VALUE, not CREATE TYPE.
DO $$ BEGIN
 CREATE TYPE "public"."recert_reviewer_strategy" AS ENUM('manager_of_subject', 'role_owner');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."recert_campaign_status" AS ENUM('draft', 'open', 'closed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

-- `organization_id` NOT NULL from birth — unlike the 0030 backfills there
-- are no pre-existing rows to adopt, so the three-step add/backfill/tighten
-- shape is unnecessary. ON DELETE RESTRICT on both FKs: an organization can
-- never be deleted out from under its attestation record, and `created_by`
-- must never silently become nobody (same reasoning as audit_log's
-- actor_user_id RESTRICT).
CREATE TABLE IF NOT EXISTS "recert_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"organization_id" uuid NOT NULL,
	"scope_role_ids" jsonb,
	"reviewer_strategy" "recert_reviewer_strategy" NOT NULL,
	"status" "recert_campaign_status" DEFAULT 'draft' NOT NULL,
	"due_date" date,
	"created_by" uuid NOT NULL,
	"opened_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recert_campaigns_organization_id_organizations_id_fk"
	 FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "recert_campaigns_created_by_users_id_fk"
	 FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action
);--> statement-breakpoint

-- The referenceable target for recert_items' composite campaign FK (0038)
-- — redundant as uniqueness (id alone implies it), existing only to be
-- referenceable, exactly like users_id_organization_key (0029).
CREATE UNIQUE INDEX IF NOT EXISTS "recert_campaigns_id_organization_key" ON "recert_campaigns" USING btree ("id","organization_id");--> statement-breakpoint

-- The console's list read. organization_id leads for the same reason it
-- leads on business_roles_enabled_idx (0030): the first discriminator once
-- more than one tenant exists.
CREATE INDEX IF NOT EXISTS "recert_campaigns_org_status_idx" ON "recert_campaigns" USING btree ("organization_id","status");

-- Recertification, migration 2 of 2 — the snapshotted review set.
--
-- One row per unit of review, written at campaign OPEN time in the same
-- transaction as the draft→open transition, from the then-current
-- provenance-carrying state (`group_user_members.grant_source`,
-- `business_role_exceptions`). The asymmetry between the two `item_kind`
-- values is the design intent the business-roles code comments already
-- wrote down:
--
--  * `role_formula` — formula-derived membership is reviewed PER ROLE: one
--    decision covers the formula, and `member_count` records how many
--    people it held at snapshot time.
--  * `include_exception` — an include-exception is reviewed PER PERSON,
--    with the MANDATORY reason (`business_role_exceptions.reason`, NOT
--    NULL precisely so a campaign can act on it) copied into
--    `exception_reason` for the reviewer to read.
--
-- `revoked_requested` — never `revoked` — because the campaign itself
-- revokes nothing: on an exception it EXPIRES the exception and the
-- reconciler (the one writer that only ever revokes what it granted) does
-- the rest; on a formula it records the finding and points the operator at
-- editing the role.
--
-- RE-RUNNABLE, same terms as 0037: duplicate_object guards on the types,
-- IF NOT EXISTS on the table and indexes.
DO $$ BEGIN
 CREATE TYPE "public"."recert_item_kind" AS ENUM('role_formula', 'include_exception');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."recert_decision" AS ENUM('pending', 'certified', 'revoked_requested');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

-- COMPOSITE FKs, the 0029 edge-table pattern: the item carries
-- organization_id itself, the campaign FK pins it to the campaign's
-- organization, and the subject/reviewer FKs pin both people to that same
-- organization — an item joining one tenant's campaign to another tenant's
-- person is refused by the database, not by convention. MATCH SIMPLE lets
-- the NULL subject of a formula item pass outright (a row that points at
-- nothing cannot be cross-tenant), exactly as users' NULL manager does.
--
-- The composite FKs can live inside CREATE TABLE because their
-- referenceable targets already exist: recert_campaigns_id_organization_key
-- (0037) and users_id_organization_key (0029).
--
-- ON DELETE RESTRICT throughout (business_role_id included): none of the
-- referenced tables has a delete route, and if one ever grows, destroying
-- review evidence must fail loudly. `decided_by` alone is SET NULL,
-- matching business_role_exceptions.granted_by's posture for "who acted".
CREATE TABLE IF NOT EXISTS "recert_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"business_role_id" uuid NOT NULL,
	"item_kind" "recert_item_kind" NOT NULL,
	"subject_user_id" uuid,
	"member_count" integer,
	"exception_reason" text,
	"exception_expires_at" timestamp with time zone,
	"reviewer_user_id" uuid NOT NULL,
	"decision" "recert_decision" DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recert_items_business_role_id_business_roles_id_fk"
	 FOREIGN KEY ("business_role_id") REFERENCES "public"."business_roles"("id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "recert_items_decided_by_users_id_fk"
	 FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "recert_items_campaign_organization_fk"
	 FOREIGN KEY ("campaign_id","organization_id") REFERENCES "public"."recert_campaigns"("id","organization_id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "recert_items_subject_organization_fk"
	 FOREIGN KEY ("subject_user_id","organization_id") REFERENCES "public"."users"("id","organization_id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "recert_items_reviewer_organization_fk"
	 FOREIGN KEY ("reviewer_user_id","organization_id") REFERENCES "public"."users"("id","organization_id") ON DELETE restrict ON UPDATE no action,
	-- Exactly the shape its kind names — belt and braces beside the
	-- application's own validation, in the same posture as
	-- business_role_grants_kind_matches_reference.
	CONSTRAINT "recert_items_kind_matches_shape"
	 CHECK (("item_kind" = 'role_formula'      AND "subject_user_id" IS NULL     AND "member_count" IS NOT NULL AND "exception_reason" IS NULL)
	     OR ("item_kind" = 'include_exception' AND "subject_user_id" IS NOT NULL AND "exception_reason" IS NOT NULL AND "member_count" IS NULL))
);--> statement-breakpoint

-- One formula item per (campaign, role); one exception item per (campaign,
-- role, person). Two PARTIAL unique indexes rather than one over the
-- triple, because NULLs are never equal in a unique index — a single index
-- would permit duplicate formula items without limit (13-development.md's
-- own rule).
CREATE UNIQUE INDEX IF NOT EXISTS "recert_items_unique_formula" ON "recert_items" USING btree ("campaign_id","business_role_id") WHERE "item_kind" = 'role_formula';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "recert_items_unique_exception" ON "recert_items" USING btree ("campaign_id","business_role_id","subject_user_id") WHERE "item_kind" = 'include_exception';--> statement-breakpoint

-- The two hot reads: a campaign's progress (count by decision) and a
-- reviewer's pending queue. Equality columns lead.
CREATE INDEX IF NOT EXISTS "recert_items_campaign_decision_idx" ON "recert_items" USING btree ("campaign_id","decision");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recert_items_reviewer_decision_idx" ON "recert_items" USING btree ("reviewer_user_id","decision");

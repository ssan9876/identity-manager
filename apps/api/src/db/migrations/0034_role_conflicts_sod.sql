-- Segregation of duties over business roles (0034).
--
-- `role_conflicts` names an UNORDERED pair of business roles that no one
-- person may hold both of, with a mandatory reason. Two mechanisms make the
-- pair genuinely unordered rather than unordered-by-convention: the CHECK
-- pins role_a_id < role_b_id (canonical ordering, which also forbids a role
-- conflicting with itself), and the unique index over the canonical pair
-- then makes (A,B) and (B,A) the SAME row — the repository sorts the pair
-- before every write, and an un-sorted row is a constraint violation, not an
-- invisible duplicate of the same policy.
--
-- NO DELETE, like everything else in this schema: a conflict is retired by
-- flipping `enabled` off, so the policy's history survives the decision to
-- stop enforcing it.
--
-- `business_roles.simulated_sod_violations` is the second half of the
-- publish gate: `recordSimulation` writes it alongside the draft hash, and
-- `publishWithin` REFUSES when the recorded simulation of this exact draft
-- found violations (and when the column is NULL beside a non-NULL hash —
-- a pre-0034 simulation that never looked). That is what makes SoD
-- PREVENTIVE at the publish boundary rather than detective after it; the
-- reconciliation sweep separately reports standing violations and never
-- auto-revokes.
--
-- Hand-written (drizzle-kit emitted the same end state with the composite
-- FKs added BEFORE the unique index they reference, which errors with
-- "there is no unique constraint matching given keys", and the new column
-- as a bare ADD COLUMN). RE-RUNNABLE, like everything from 0027 onward:
-- test/migrate.spec.ts rewinds the ledger and replays this tail against a
-- populated schema, so IF NOT EXISTS and duplicate_object guards throughout
-- (0029 and 0030 are the models).

-- ---------------------------------------------------------------------------
-- 1. The publish gate's new column. Nullable, and deliberately NOT
--    backfilled to 0: for a pre-existing simulated draft NULL is the honest
--    value — its simulation never looked for violations — and the
--    repository's gate turns that NULL into "simulate again", not into a
--    silent pass.
-- ---------------------------------------------------------------------------
ALTER TABLE "business_roles" ADD COLUMN IF NOT EXISTS "simulated_sod_violations" integer;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. The referenceable target, BEFORE the composite FKs that need it — a
--    composite FK can only reference a unique key over exactly the
--    referenced pair (0029's own note, verbatim, for org_units/users/groups).
--    Strictly redundant as uniqueness; it exists only to be referenceable.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS "business_roles_id_organization_key" ON "business_roles" USING btree ("id","organization_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. The table itself.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "role_conflicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"role_a_id" uuid NOT NULL,
	"role_b_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_conflicts_canonical_pair" CHECK ("role_conflicts"."role_a_id" < "role_conflicts"."role_b_id")
);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Single-column FKs. ON DELETE RESTRICT on both role references: nothing
--    deletes a business role today, and if something ever does, a policy
--    silently losing one of its two sides must be a loud failure. The
--    organization FK matches business_roles' own (0030): an organization can
--    never be deleted out from under the policies that constrain its access.
--    created_by is SET NULL like business_role_exceptions.granted_by — the
--    author's account may legitimately go before the policy does.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
 ALTER TABLE "role_conflicts" ADD CONSTRAINT "role_conflicts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "role_conflicts" ADD CONSTRAINT "role_conflicts_role_a_id_business_roles_id_fk" FOREIGN KEY ("role_a_id") REFERENCES "public"."business_roles"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "role_conflicts" ADD CONSTRAINT "role_conflicts_role_b_id_business_roles_id_fk" FOREIGN KEY ("role_b_id") REFERENCES "public"."business_roles"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "role_conflicts" ADD CONSTRAINT "role_conflicts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. Composite FKs, the 0029 pattern: both role references carry the
--    conflict's own organization_id, so a conflict can only ever join two
--    roles of ITS OWN organization — one tenant's SoD policy cannot name
--    (and thereby probe for, or veto publishes of) another tenant's roles.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
 ALTER TABLE "role_conflicts" ADD CONSTRAINT "rc_role_a_organization_fk" FOREIGN KEY ("role_a_id","organization_id") REFERENCES "public"."business_roles"("id","organization_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "role_conflicts" ADD CONSTRAINT "rc_role_b_organization_fk" FOREIGN KEY ("role_b_id","organization_id") REFERENCES "public"."business_roles"("id","organization_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 6. The reads: the publish gate and the standing checker both ask for
--    enabled conflicts one organization at a time; the pair index is the
--    uniqueness that makes the unordered pair a single row.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS "role_conflicts_pair_unique" ON "role_conflicts" USING btree ("role_a_id","role_b_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "role_conflicts_organization_idx" ON "role_conflicts" USING btree ("organization_id","enabled");

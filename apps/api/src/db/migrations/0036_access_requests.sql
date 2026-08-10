-- Access-request catalogue, part 2 of 2: the `access_requests` table —
-- "person X asks for business role Y, with a justification, and the
-- resolved approver decides".
--
-- Shape decisions (see db/schema/access-requests.ts for the full doc):
--
--  * requester AND subject columns, equal today by construction (the
--    controller sets both from the verified JWT principal): on-behalf-of
--    later becomes a data change, never a schema migration.
--  * `state` is a closed enum, pending → approved | denied | cancelled;
--    every non-pending state is TERMINAL. The transition rule lives in
--    AccessRequestsRepository (every state write is `WHERE state =
--    'pending'`), and the `access_requests_decision_shape` CHECK pins the
--    row shape each state may carry.
--  * `approver_resolver` is a CLOSED VOCABULARY, exactly the JML "rules are
--    data, never code" posture: two resolvers, as enum labels — the
--    subject's manager, and the super_admin-holder fallback for subjects
--    with no manager. No expression language, no admin-authored scripts.
--  * `justification` is NOT NULL and CHECK-non-empty for the same reason
--    `business_role_exceptions.reason` is: an approved request becomes an
--    include EXCEPTION on the role, and an unexplained exception is what a
--    recertification campaign cannot act on.
--  * No delete, ever — requests are an append-only record; terminal states
--    are how one ends.
--  * `organization_id` with the 0029 composite-FK pattern: the subject and
--    the requested role are both pinned to the request's own organization,
--    so a cross-tenant request is unrepresentable at the database.
--
-- RE-RUNNABLE, like everything from 0027 onward (test/migrate.spec.ts
-- replays this tail): duplicate_object guards on the types and
-- constraints, IF NOT EXISTS on the table and indexes — 0029/0030 are the
-- models.

DO $$ BEGIN
 CREATE TYPE "public"."access_request_state" AS ENUM('pending', 'approved', 'denied', 'cancelled');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."access_request_approver_resolver" AS ENUM('manager_of_subject', 'role_holder:super_admin');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "access_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"requester_user_id" uuid NOT NULL,
	"subject_user_id" uuid NOT NULL,
	"business_role_id" uuid NOT NULL,
	"justification" text NOT NULL,
	"state" "access_request_state" DEFAULT 'pending' NOT NULL,
	"approver_resolver" "access_request_approver_resolver" NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_comment" text,
	"requested_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_requests_justification_non_empty" CHECK (length(btrim("justification")) > 0),
	CONSTRAINT "access_requests_decision_shape" CHECK (("state" = 'pending' AND "decided_by" IS NULL AND "decided_at" IS NULL AND "decision_comment" IS NULL)
       OR ("state" <> 'pending' AND "decided_at" IS NOT NULL))
);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Single-column FKs. RESTRICT on the endpoints that explain the request
-- (requester, subject, role, organization) — none of them has a delete path
-- today, and none may ever gain one that silently erases who asked for
-- what. `decided_by` is `set null`, matching
-- `business_role_exceptions.granted_by`: the audit log carries the durable
-- copy of every decision.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
 ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_requester_user_id_users_id_fk"
  FOREIGN KEY ("requester_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_subject_user_id_users_id_fk"
  FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_business_role_id_business_roles_id_fk"
  FOREIGN KEY ("business_role_id") REFERENCES "public"."business_roles"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_decided_by_users_id_fk"
  FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The composite FKs (0029's pattern). `users_id_organization_key` exists
-- since 0029; `business_roles` needs its own referenceable pair — strictly
-- redundant as uniqueness (`id` alone already implies it), existing only to
-- be referenceable, exactly like 0029's own three.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS "business_roles_id_organization_key" ON "business_roles" USING btree ("id","organization_id");--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_subject_organization_fk"
  FOREIGN KEY ("subject_user_id","organization_id") REFERENCES "public"."users"("id","organization_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_role_organization_fk"
  FOREIGN KEY ("business_role_id","organization_id") REFERENCES "public"."business_roles"("id","organization_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The reads these indexes serve: "my requests" (requester), the approvals
-- inbox (pending, found through the SUBJECT whose manager decides), the
-- org-wide pending view, and "requests for this role".
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "access_requests_requester_idx" ON "access_requests" USING btree ("requester_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "access_requests_subject_state_idx" ON "access_requests" USING btree ("subject_user_id","state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "access_requests_org_state_idx" ON "access_requests" USING btree ("organization_id","state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "access_requests_role_idx" ON "access_requests" USING btree ("business_role_id");

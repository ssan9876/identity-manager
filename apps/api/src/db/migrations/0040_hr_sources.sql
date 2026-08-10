-- HR inbound feed — `hr_sources`: pull-based HR sources that feed the
-- EXISTING bulk-import pipeline (imports/imports.controller.ts). The
-- standing rule is "nothing writes into this system except its own API": a
-- source row describes where THIS system goes to fetch a CSV over HTTPS —
-- never a pushed webhook, never SCIM inbound.
--
-- Numbered 0040 — reserved for this branch; sibling branches hold
-- 0033–0039, and the merge coordinator resolves the cross-branch snapshot
-- chain. See db/schema/hr-sources.ts for the full column-level rationale.
--
-- SECRET DISCIPLINE (decision 4 of the connectors design, verbatim from
-- connector_targets): `auth_secret_name` stores the NAME of a CONNECTOR_*
-- environment variable, never a value. Nothing in this codebase ever writes
-- a credential VALUE into this table, so nothing ever needs redacting on
-- the way out.
--
-- NO DELETE: a source that has run is named by append-only audit rows
-- (`hr_source:sync`), so it is disabled instead of removed. No code path
-- issues a DELETE against this table.
--
-- RE-RUNNABLE, like everything from 0027 onward: test/migrate.spec.ts
-- replays the ledger tail against a populated schema, so the enum creations
-- are wrapped in duplicate_object guards, the table is IF NOT EXISTS (its
-- inline CHECK constraints ride inside that guard), and the FK/index carry
-- their own guards — 0030 is the model.

DO $$ BEGIN
 CREATE TYPE "public"."hr_source_kind" AS ENUM('csv_url');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
 CREATE TYPE "public"."hr_run_outcome" AS ENUM('fetch_failed', 'preview_failed', 'previewed', 'aborted_failures', 'aborted_blast_radius', 'committed', 'committed_partial');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hr_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"kind" "hr_source_kind" NOT NULL,
	"url" varchar(2048) NOT NULL,
	"auth_header_name" varchar(128),
	"auth_secret_name" varchar(128),
	"column_mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"blast_radius_threshold" integer DEFAULT 20 NOT NULL,
	"blast_radius_floor" integer DEFAULT 5 NOT NULL,
	"last_run_started_at" timestamp with time zone,
	"last_run_finished_at" timestamp with time zone,
	"last_run_outcome" "hr_run_outcome",
	"last_run_counts" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- Belt-and-braces alongside the controller's Zod validation, same
	-- posture as connector_targets_threshold_range: an out-of-range value
	-- here would silently defeat — or permanently trip — the blast-radius
	-- guard; a header name with no secret (or vice versa) is always a
	-- misconfiguration; a plain-HTTP url would carry PII and the auth
	-- header in cleartext.
	CONSTRAINT "hr_sources_threshold_range" CHECK ("hr_sources"."blast_radius_threshold" BETWEEN 1 AND 100),
	CONSTRAINT "hr_sources_floor_non_negative" CHECK ("hr_sources"."blast_radius_floor" >= 0),
	CONSTRAINT "hr_sources_auth_pair" CHECK (("hr_sources"."auth_header_name" IS NULL) = ("hr_sources"."auth_secret_name" IS NULL)),
	CONSTRAINT "hr_sources_url_https" CHECK ("hr_sources"."url" LIKE 'https://%')
);--> statement-breakpoint

-- ON DELETE RESTRICT, matching users/org_units/groups/jml_rules (0025/0030):
-- an organization can never be removed out from under the feed that
-- provisions its people.
DO $$ BEGIN
 ALTER TABLE "hr_sources" ADD CONSTRAINT "hr_sources_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

-- Unique PER ORGANIZATION, never globally — same reasoning as 0028/0030: a
-- global unique name is an existence oracle across the tenant boundary.
-- HrSourcesRepository.translateWriteError matches this index NAME to turn a
-- 23505 into a ConflictError; renaming it would silently turn a 409 into a
-- 500 (0028's note, verbatim).
CREATE UNIQUE INDEX IF NOT EXISTS "hr_sources_org_name_unique" ON "hr_sources" USING btree ("organization_id","name");

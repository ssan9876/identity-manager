ALTER TYPE "public"."outbox_target" ADD VALUE 'active_directory';--> statement-breakpoint
ALTER TYPE "public"."outbox_target" ADD VALUE 'entra_id';--> statement-breakpoint
ALTER TYPE "public"."outbox_target" ADD VALUE 'google_workspace';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "connector_targets" (
	"target" "outbox_target" PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"blast_radius_threshold" integer DEFAULT 20 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Seed 'keycloak' as enabled so OutboxWriter.record's existing fan-out
-- behaviour (one row, target='keycloak', for every mutation) is unchanged
-- by this migration landing (see connector-targets.ts's own doc comment).
-- Deliberately does NOT also seed 'active_directory' / 'entra_id' /
-- 'google_workspace' rows here: those enum values are added by the ALTER
-- TYPE statements above, in this SAME migration, and Postgres forbids using
-- a value added by ALTER TYPE ... ADD VALUE within the transaction that
-- added it ("unsafe use of new value of enum type") — drizzle's migrator
-- applies every pending migration for one run inside a single transaction,
-- so a fresh database (every Testcontainer; a fresh deploy) would fail this
-- migration outright if it tried. 'keycloak' has no such restriction — it
-- has existed since outbox_target's original migration — so only it is
-- seeded here. ON CONFLICT is defensive belt-and-braces (this INSERT should
-- only ever run once, on a table this same migration just created).
INSERT INTO "connector_targets" ("target", "enabled") VALUES ('keycloak', true)
ON CONFLICT ("target") DO NOTHING;

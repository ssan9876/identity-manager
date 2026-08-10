-- SAML 2.0 application support (feat/saml-apps).
--
-- `sso_app_protocol` finally earns its keep: the enum existed with one value
-- precisely so SAML could arrive as a WIDENING rather than a reshape (its own
-- schema comment said as much). 'saml' is ADDED here and USED nowhere in this
-- migration — no default, no backfill, no CHECK referencing it — because
-- drizzle applies the pending tail in ONE transaction and Postgres rejects
-- "unsafe use of new value of enum type" for a value added by ALTER TYPE in
-- the same transaction (docs/13, "Rules that will bite you"). That is also
-- why there is deliberately NO CHECK constraint tying the SAML columns to
-- protocol = 'saml'; the closed request schemas in sso-apps.controller.ts
-- own that shape rule, as they already own every other rule for this table.
--
-- Existing rows need no protocol backfill: the column has been NOT NULL
-- DEFAULT 'openid-connect' since 0025, so every pre-SAML row already reads
-- as the OIDC protocol. The new SAML columns are nullable and stay NULL on
-- every OIDC row — nullable rather than defaulted so an OIDC row cannot
-- quietly carry a plausible-looking SAML configuration.
--
-- There is no separate entity-id column. Keycloak keys a SAML client by the
-- SP's entity id in the SAME clientId field this table already has, so the
-- entity id lives in `client_id` — one column, one uniqueness rule, one
-- reserved-name denylist, no second value to drift.
--
-- RE-RUNNABLE, like everything from 0027 onward: test/migrate.spec.ts
-- rewinds the ledger and replays this whole tail against a populated schema,
-- hence IF NOT EXISTS on every statement and the duplicate_object guard on
-- the new enum type.
ALTER TYPE "sso_app_protocol" ADD VALUE IF NOT EXISTS 'saml';--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "sso_app_name_id_format" AS ENUM ('email', 'persistent', 'username');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
ALTER TABLE "sso_apps" ADD COLUMN IF NOT EXISTS "saml_acs_urls" text[];--> statement-breakpoint
ALTER TABLE "sso_apps" ADD COLUMN IF NOT EXISTS "saml_sp_certificate" text;--> statement-breakpoint
ALTER TABLE "sso_apps" ADD COLUMN IF NOT EXISTS "saml_sign_assertions" boolean;--> statement-breakpoint
ALTER TABLE "sso_apps" ADD COLUMN IF NOT EXISTS "saml_name_id_format" "sso_app_name_id_format";

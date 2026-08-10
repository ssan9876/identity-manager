-- The six SCIM 2.0 application slots. Added to BOTH enums, which must stay
-- one-for-one: SyncWorker writes `outbox_events.target` straight into
-- `external_identities.system` with no mapping table between them
-- (connectors/connector.ts, db/schema/external-identities.ts).
--
-- No row is inserted here USING any of these values, deliberately: Postgres
-- forbids using a value added by ALTER TYPE ... ADD VALUE inside the
-- transaction that added it, and drizzle applies every pending migration in
-- one transaction. A target with no connector_targets row is simply
-- unconfigured, which is the correct starting state anyway.
--
-- IF NOT EXISTS on every line for the same reason as 0041: everything from
-- 0027 onwards is replayed by test/migrate.spec.ts and must be re-runnable.
ALTER TYPE "public"."external_identity_system" ADD VALUE IF NOT EXISTS 'scim_slack' BEFORE 'keycloak_sso';--> statement-breakpoint
ALTER TYPE "public"."external_identity_system" ADD VALUE IF NOT EXISTS 'scim_zoom' BEFORE 'keycloak_sso';--> statement-breakpoint
ALTER TYPE "public"."external_identity_system" ADD VALUE IF NOT EXISTS 'scim_atlassian' BEFORE 'keycloak_sso';--> statement-breakpoint
ALTER TYPE "public"."external_identity_system" ADD VALUE IF NOT EXISTS 'scim_box' BEFORE 'keycloak_sso';--> statement-breakpoint
ALTER TYPE "public"."external_identity_system" ADD VALUE IF NOT EXISTS 'scim_snowflake' BEFORE 'keycloak_sso';--> statement-breakpoint
ALTER TYPE "public"."external_identity_system" ADD VALUE IF NOT EXISTS 'scim_generic' BEFORE 'keycloak_sso';--> statement-breakpoint
ALTER TYPE "public"."outbox_target" ADD VALUE IF NOT EXISTS 'scim_slack' BEFORE 'keycloak_sso';--> statement-breakpoint
ALTER TYPE "public"."outbox_target" ADD VALUE IF NOT EXISTS 'scim_zoom' BEFORE 'keycloak_sso';--> statement-breakpoint
ALTER TYPE "public"."outbox_target" ADD VALUE IF NOT EXISTS 'scim_atlassian' BEFORE 'keycloak_sso';--> statement-breakpoint
ALTER TYPE "public"."outbox_target" ADD VALUE IF NOT EXISTS 'scim_box' BEFORE 'keycloak_sso';--> statement-breakpoint
ALTER TYPE "public"."outbox_target" ADD VALUE IF NOT EXISTS 'scim_snowflake' BEFORE 'keycloak_sso';--> statement-breakpoint
ALTER TYPE "public"."outbox_target" ADD VALUE IF NOT EXISTS 'scim_generic' BEFORE 'keycloak_sso';

-- Postgres forbids USING a value added by ALTER TYPE ... ADD VALUE within the
-- transaction that added it, and every pending migration runs in ONE
-- transaction on a fresh database. So no migration -- not this one and not a
-- later one -- may INSERT a connector_targets row keyed 'keycloak_sso'. That
-- row is created at runtime through PATCH /connector-targets/keycloak_sso, or
-- directly by a test, exactly as every other non-keycloak target already is.
-- See migration 0017 and outbox-events.ts's outboxTarget doc comment.
ALTER TYPE "public"."external_identity_system" ADD VALUE 'keycloak_sso';--> statement-breakpoint
ALTER TYPE "public"."outbox_aggregate_type" ADD VALUE 'sso_app';--> statement-breakpoint
ALTER TYPE "public"."outbox_target" ADD VALUE 'keycloak_sso';
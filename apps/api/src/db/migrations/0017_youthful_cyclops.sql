-- Postgres forbids USING a value added by ALTER TYPE ... ADD VALUE within the
-- transaction that added it, and every pending migration runs in ONE
-- transaction on a fresh database. So no migration may INSERT a
-- connector_targets row keyed 'mail_server' — that row is created at runtime
-- (or by a test inserting it directly), exactly as the other non-keycloak
-- targets already are. See outbox-events.ts's own outboxTarget doc comment.
ALTER TYPE "public"."external_identity_system" ADD VALUE 'mail_server';--> statement-breakpoint
ALTER TYPE "public"."outbox_target" ADD VALUE 'mail_server';
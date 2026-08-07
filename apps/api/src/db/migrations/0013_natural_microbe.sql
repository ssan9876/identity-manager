ALTER TYPE "public"."external_identity_system" ADD VALUE 'entra_id' BEFORE 'google_workspace';--> statement-breakpoint
ALTER TYPE "public"."external_identity_system" ADD VALUE 'echo';--> statement-breakpoint
ALTER TYPE "public"."outbox_target" ADD VALUE 'echo';
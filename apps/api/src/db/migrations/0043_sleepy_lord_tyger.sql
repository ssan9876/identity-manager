-- Re-runnable: migrate.spec.ts replays every migration from 0027 onward.
ALTER TABLE "attribute_definitions" DROP CONSTRAINT IF EXISTS "attribute_definitions_key_format";--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD CONSTRAINT "attribute_definitions_key_format" CHECK ("attribute_definitions"."key" ~ '^[A-Za-z_][A-Za-z0-9_]*$' AND "attribute_definitions"."key" NOT IN ('__proto__', 'constructor', 'prototype'));

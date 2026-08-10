-- RE-RUNNABLE, deliberately. test/migrate.spec.ts rewinds the migration
-- ledger to 0027 and replays everything from there, so every migration from
-- 0027 onwards must tolerate being applied twice (that test's own comment:
-- "any new one must be too"). A bare ALTER TYPE ... ADD VALUE fails the
-- second time with 42710 "enum label already exists", which is exactly how
-- this file was first written and exactly what that test caught.
ALTER TYPE "public"."hr_source_kind" ADD VALUE IF NOT EXISTS 'rest_json';--> statement-breakpoint
ALTER TABLE "hr_sources" ADD COLUMN IF NOT EXISTS "config" jsonb DEFAULT '{}'::jsonb NOT NULL;

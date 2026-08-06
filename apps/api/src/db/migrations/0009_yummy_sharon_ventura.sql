ALTER TABLE "audit_log" ADD COLUMN "batch_id" uuid;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_batch_idx" ON "audit_log" USING btree ("batch_id");
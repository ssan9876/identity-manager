CREATE TABLE IF NOT EXISTS "external_group_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"system" "external_identity_system" NOT NULL,
	"external_id" varchar(255) NOT NULL,
	"last_synced_at" timestamp with time zone,
	"sync_state" "external_identity_sync_state" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "external_group_identities" ADD CONSTRAINT "external_group_identities_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "external_group_identities_group_system_unique" ON "external_group_identities" USING btree ("group_id","system");
CREATE TABLE IF NOT EXISTS "group_group_members" (
	"parent_group_id" uuid NOT NULL,
	"child_group_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_group_members_parent_group_id_child_group_id_pk" PRIMARY KEY("parent_group_id","child_group_id"),
	CONSTRAINT "group_group_members_no_self_edge" CHECK ("group_group_members"."parent_group_id" <> "group_group_members"."child_group_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "group_user_members" (
	"group_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_user_members_group_id_user_id_pk" PRIMARY KEY("group_id","user_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "group_group_members" ADD CONSTRAINT "group_group_members_parent_group_id_groups_id_fk" FOREIGN KEY ("parent_group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "group_group_members" ADD CONSTRAINT "group_group_members_child_group_id_groups_id_fk" FOREIGN KEY ("child_group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "group_user_members" ADD CONSTRAINT "group_user_members_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "group_user_members" ADD CONSTRAINT "group_user_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "group_group_members_child_idx" ON "group_group_members" USING btree ("child_group_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "group_user_members_user_idx" ON "group_user_members" USING btree ("user_id");
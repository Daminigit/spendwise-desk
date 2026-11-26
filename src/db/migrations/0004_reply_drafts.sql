CREATE TABLE IF NOT EXISTS "reply_drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text,
	"via" text NOT NULL,
	"channel" text NOT NULL,
	"question" text NOT NULL,
	"topic" text NOT NULL,
	"covered" boolean NOT NULL,
	"drafter" text NOT NULL,
	"draft" text NOT NULL,
	"sources" json NOT NULL,
	"searched" json NOT NULL,
	"routing" json NOT NULL,
	"review" json NOT NULL,
	"agents" json NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"edited" boolean DEFAULT false NOT NULL,
	"final_reply" text,
	"reject_reason" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reply_drafts" ADD CONSTRAINT "reply_drafts_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reply_drafts" ADD CONSTRAINT "reply_drafts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reply_drafts" ADD CONSTRAINT "reply_drafts_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reply_drafts_org_status_idx" ON "reply_drafts" USING btree ("org_id","status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reply_drafts_user_idx" ON "reply_drafts" USING btree ("user_id","created_at");
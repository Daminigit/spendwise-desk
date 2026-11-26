CREATE TABLE IF NOT EXISTS "assistant_events" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text,
	"channel" text NOT NULL,
	"intent" text NOT NULL,
	"outcome" text NOT NULL,
	"text_redacted" text NOT NULL,
	"pii_found" json DEFAULT '[]'::json NOT NULL,
	"meta" json,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assistant_events" ADD CONSTRAINT "assistant_events_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assistant_events" ADD CONSTRAINT "assistant_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assistant_events_org_created_idx" ON "assistant_events" USING btree ("org_id","created_at");
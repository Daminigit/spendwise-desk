CREATE TABLE IF NOT EXISTS "canonical_answers" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"topic" text NOT NULL,
	"title" text NOT NULL,
	"bullets" json NOT NULL,
	"sources" json NOT NULL,
	"last_checked" text NOT NULL,
	"action_id" text,
	"approved_by" text,
	"active" boolean DEFAULT true NOT NULL,
	"times_reused" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "published_outputs" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"action_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"meta" json,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "run_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"run_id" text NOT NULL,
	"kind" text NOT NULL,
	"target" text NOT NULL,
	"payload" json NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"edited" boolean DEFAULT false NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "weekly_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"window_start" text NOT NULL,
	"window_end" text NOT NULL,
	"trigger" text NOT NULL,
	"themes" json NOT NULL,
	"stats" json NOT NULL,
	"pulse" json NOT NULL,
	"explainer" json,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "canonical_answers" ADD CONSTRAINT "canonical_answers_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "canonical_answers" ADD CONSTRAINT "canonical_answers_action_id_run_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."run_actions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "canonical_answers" ADD CONSTRAINT "canonical_answers_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "published_outputs" ADD CONSTRAINT "published_outputs_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "published_outputs" ADD CONSTRAINT "published_outputs_action_id_run_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."run_actions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "run_actions" ADD CONSTRAINT "run_actions_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "run_actions" ADD CONSTRAINT "run_actions_run_id_weekly_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."weekly_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "run_actions" ADD CONSTRAINT "run_actions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "weekly_runs" ADD CONSTRAINT "weekly_runs_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "canonical_answers_org_topic_idx" ON "canonical_answers" USING btree ("org_id","topic");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "published_outputs_action_idx" ON "published_outputs" USING btree ("action_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_actions_run_idx" ON "run_actions" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "weekly_runs_org_idx" ON "weekly_runs" USING btree ("org_id","created_at");
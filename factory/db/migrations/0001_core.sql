CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text,
	"provider" text,
	"adapter_type" text,
	"capabilities" jsonb,
	"enabled" boolean,
	"concurrency_limit" integer,
	"configuration" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"row_version" bigint DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text,
	"role" text,
	"owner_id" uuid,
	"worker_id" uuid,
	"prefix" text,
	"token_hash" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"replaces_token_id" uuid,
	"valid_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" bigint DEFAULT 1 NOT NULL,
	CONSTRAINT "api_tokens_prefix_unique" UNIQUE("prefix"),
	CONSTRAINT "api_tokens_role" CHECK ("api_tokens"."role" IN ('owner','worker','relay','reader')),
	CONSTRAINT "api_tokens_owner_binding" CHECK ("api_tokens"."role" <> 'owner' OR "api_tokens"."owner_id" IS NOT NULL),
	CONSTRAINT "api_tokens_worker_binding" CHECK ("api_tokens"."role" <> 'worker' OR "api_tokens"."worker_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"commit_xid" "xid8" DEFAULT pg_current_xact_id() NOT NULL,
	"actor_id" uuid,
	"token_id" uuid,
	"request_id" uuid,
	"action" text,
	"target_type" text,
	"target_id" uuid,
	"outcome" text,
	"request_hash" text,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_log_seq_unique" UNIQUE("seq"),
	CONSTRAINT "audit_log_outcome" CHECK ("audit_log"."outcome" IN ('ok','denied','failed','needs_confirmation'))
);
--> statement-breakpoint
CREATE TABLE "execution_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid,
	"version" integer,
	"allowed_commands" text[],
	"allowed_directories" text[],
	"allowed_repositories" text[],
	"network" jsonb,
	"git_operations" text[],
	"confirmation_required" text[],
	"allowed_tools" text[],
	"max_concurrent_tasks" integer,
	"max_tasks_per_agent" integer,
	"max_run_seconds" integer,
	"max_tokens" integer,
	"max_cost" numeric,
	"currency" text,
	"max_auto_fixes" integer,
	"max_attempts" integer,
	"max_rework_rounds" integer,
	"max_child_depth" integer,
	"max_children_per_task" integer,
	"auto_accept_low_risk" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_policies_project_version" UNIQUE("project_id","version")
);
--> statement-breakpoint
CREATE TABLE "owners" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text,
	"telegram_user_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" bigint DEFAULT 1 NOT NULL,
	CONSTRAINT "owners_telegram_user_id_unique" UNIQUE("telegram_user_id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text,
	"description" text,
	"repository_url" text,
	"default_branch" text,
	"workspace_policy" text,
	"settings" jsonb,
	"priority" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"row_version" bigint DEFAULT 1 NOT NULL,
	CONSTRAINT "projects_workspace_policy" CHECK ("projects"."workspace_policy" = 'worktree')
);
--> statement-breakpoint
CREATE TABLE "routing_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid,
	"position" integer,
	"match" jsonb,
	"preferred_agent_ids" uuid[],
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"row_version" bigint DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" bigint DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"machine_id" text,
	"name" text,
	"platform" text,
	"capabilities" jsonb,
	"version" text,
	"contract_version" integer,
	"last_seen_at" timestamp with time zone,
	"status" text,
	"concurrency_limit" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" bigint DEFAULT 1 NOT NULL,
	CONSTRAINT "workers_machine_id_unique" UNIQUE("machine_id"),
	CONSTRAINT "workers_status" CHECK ("workers"."status" IN ('online','offline','outdated','disabled'))
);
--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_live_name" ON "agents" USING btree ("name") WHERE "agents"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "audit_log_cursor" ON "audit_log" USING btree ("commit_xid","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_live_name" ON "projects" USING btree ("name") WHERE "projects"."deleted_at" IS NULL;
--> statement-breakpoint
CREATE FUNCTION af_refuse_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'hard deletion is forbidden';
END;
$$;
--> statement-breakpoint
CREATE FUNCTION af_refuse_immutable_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable row cannot be changed';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER execution_policies_immutable BEFORE UPDATE OR DELETE ON execution_policies FOR EACH ROW EXECUTE FUNCTION af_refuse_immutable_change();
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION af_refuse_immutable_change();
--> statement-breakpoint
CREATE FUNCTION af_project_soft_delete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE has_active boolean;
BEGIN
  IF NEW.deleted_at IS NOT NULL THEN
    IF NEW.archived_at IS NULL THEN RAISE EXCEPTION 'project must be archived before deletion'; END IF;
    IF to_regclass('public.tasks') IS NOT NULL THEN
      EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.tasks WHERE project_id = $1 AND deleted_at IS NULL AND origin_type IS DISTINCT FROM ''standing'' AND (status IS NULL OR status NOT IN (''ACCEPTED'', ''REJECTED'', ''CANCELLED'', ''FAILED'')))' INTO has_active USING NEW.id;
      IF has_active THEN RAISE EXCEPTION 'project has active tasks'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER projects_soft_delete BEFORE INSERT OR UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION af_project_soft_delete();
--> statement-breakpoint
CREATE TRIGGER owners_no_delete BEFORE DELETE ON owners FOR EACH ROW EXECUTE FUNCTION af_refuse_delete();
CREATE TRIGGER projects_no_delete BEFORE DELETE ON projects FOR EACH ROW EXECUTE FUNCTION af_refuse_delete();
CREATE TRIGGER agents_no_delete BEFORE DELETE ON agents FOR EACH ROW EXECUTE FUNCTION af_refuse_delete();
CREATE TRIGGER workers_no_delete BEFORE DELETE ON workers FOR EACH ROW EXECUTE FUNCTION af_refuse_delete();
CREATE TRIGGER settings_no_delete BEFORE DELETE ON settings FOR EACH ROW EXECUTE FUNCTION af_refuse_delete();
CREATE TRIGGER routing_rules_no_delete BEFORE DELETE ON routing_rules FOR EACH ROW EXECUTE FUNCTION af_refuse_delete();
CREATE TRIGGER api_tokens_no_delete BEFORE DELETE ON api_tokens FOR EACH ROW EXECUTE FUNCTION af_refuse_delete();
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON owners, projects, agents, workers, settings, routing_rules, api_tokens TO af_api, af_control;
GRANT SELECT, INSERT ON execution_policies, audit_log TO af_api, af_control;
GRANT SELECT ON owners, projects, agents, workers, settings, execution_policies, routing_rules, api_tokens, audit_log, af_migrations TO af_backup;
GRANT SELECT ON SEQUENCE audit_log_seq_seq TO af_backup;

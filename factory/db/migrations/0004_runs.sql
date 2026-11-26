CREATE TABLE "workspaces" (
 "id" uuid PRIMARY KEY NOT NULL, "task_id" uuid CONSTRAINT "workspaces_task_id_tasks_id_fk" REFERENCES "tasks"("id") ON DELETE RESTRICT, "worker_id" uuid CONSTRAINT "workspaces_worker_id_workers_id_fk" REFERENCES "workers"("id") ON DELETE RESTRICT,
 "repository" text, "base_commit" text, "branch" text, "worktree_path" text, "state" text, "commits" jsonb, "pull_request_url" text,
 "created_at" timestamptz DEFAULT now() NOT NULL, "cleaned_at" timestamptz, "updated_at" timestamptz DEFAULT now() NOT NULL, "row_version" bigint DEFAULT 1 NOT NULL,
 CONSTRAINT "workspaces_state" CHECK ("state" IN ('prepared','in_use','done','cleaned','kept'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_in_use_path" ON "workspaces" ("worktree_path") WHERE "state" = 'in_use';
--> statement-breakpoint
CREATE TABLE "task_runs" (
 "id" uuid PRIMARY KEY NOT NULL, "task_id" uuid NOT NULL CONSTRAINT "task_runs_task_id_tasks_id_fk" REFERENCES "tasks"("id") ON DELETE RESTRICT, "attempt_number" integer, "role" text,
 "agent_id" uuid CONSTRAINT "task_runs_agent_id_agents_id_fk" REFERENCES "agents"("id") ON DELETE RESTRICT, "worker_id" uuid CONSTRAINT "task_runs_worker_id_workers_id_fk" REFERENCES "workers"("id") ON DELETE RESTRICT,
 "temporal_activity_id" text, "execution_id" uuid CONSTRAINT "task_runs_execution_id_unique" UNIQUE, "session_id" text, "workspace_id" uuid CONSTRAINT "task_runs_workspace_id_workspaces_id_fk" REFERENCES "workspaces"("id") ON DELETE RESTRICT,
 "task_revision" integer, "policy_id" uuid CONSTRAINT "task_runs_policy_id_execution_policies_id_fk" REFERENCES "execution_policies"("id") ON DELETE RESTRICT, "contract_version" integer, "status" text,
 "gpu_wait_since" timestamptz, "started_at" timestamptz, "heartbeat_at" timestamptz, "finished_at" timestamptz, "exit_code" integer,
 "error_code" text, "error_message" text, "result_summary" text, "usage_metrics" jsonb, "created_at" timestamptz DEFAULT now() NOT NULL,
 "updated_at" timestamptz DEFAULT now() NOT NULL, "row_version" bigint DEFAULT 1 NOT NULL,
 CONSTRAINT "task_runs_task_attempt" UNIQUE ("task_id","attempt_number"), CONSTRAINT "task_runs_role" CHECK ("role" IN ('planner','implementer','tester','reviewer')),
 CONSTRAINT "task_runs_status" CHECK ("status" IN ('created','starting','running','finished','failed','died','unclear','cancelling','cancelled'))
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_origin_run_id_task_runs_id_fk" FOREIGN KEY ("origin_run_id") REFERENCES "task_runs"("id") ON DELETE RESTRICT;
ALTER TABLE "task_decisions" ADD CONSTRAINT "task_decisions_engineer_run_id_task_runs_id_fk" FOREIGN KEY ("engineer_run_id") REFERENCES "task_runs"("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE TABLE "task_events" (
 "id" uuid PRIMARY KEY NOT NULL, "seq" bigint GENERATED ALWAYS AS IDENTITY NOT NULL CONSTRAINT "task_events_seq_unique" UNIQUE, "commit_xid" xid8 DEFAULT pg_current_xact_id() NOT NULL,
 "task_id" uuid CONSTRAINT "task_events_task_id_tasks_id_fk" REFERENCES "tasks"("id") ON DELETE RESTRICT, "run_id" uuid CONSTRAINT "task_events_run_id_task_runs_id_fk" REFERENCES "task_runs"("id") ON DELETE RESTRICT,
 "event_type" text, "actor_type" text, "actor_id" uuid, "payload" jsonb, "correlation_id" text, "dedupe_key" text, "created_at" timestamptz DEFAULT now() NOT NULL,
 CONSTRAINT "task_events_task_dedupe" UNIQUE ("task_id","dedupe_key"), CONSTRAINT "task_events_actor_type" CHECK ("actor_type" IN ('owner','worker','workflow','system'))
);
CREATE INDEX "task_events_cursor" ON "task_events" ("commit_xid","seq");
--> statement-breakpoint
CREATE TABLE "task_artifacts" (
 "id" uuid PRIMARY KEY NOT NULL, "task_id" uuid CONSTRAINT "task_artifacts_task_id_tasks_id_fk" REFERENCES "tasks"("id") ON DELETE RESTRICT, "run_id" uuid CONSTRAINT "task_artifacts_run_id_task_runs_id_fk" REFERENCES "task_runs"("id") ON DELETE RESTRICT,
 "artifact_type" text, "storage_backend" text, "storage_key" text, "checksum" text, "size" bigint, "metadata" jsonb, "upload_state" text, "client_upload_id" text,
 "created_at" timestamptz DEFAULT now() NOT NULL, "confirmed_at" timestamptz, "removed_at" timestamptz, "removed_by" uuid,
 "updated_at" timestamptz DEFAULT now() NOT NULL, "row_version" bigint DEFAULT 1 NOT NULL,
 CONSTRAINT "task_artifacts_storage_key" UNIQUE ("storage_backend","storage_key"), CONSTRAINT "task_artifacts_client_upload" UNIQUE ("run_id","client_upload_id"),
 CONSTRAINT "task_artifacts_type" CHECK ("artifact_type" IN ('log','result','report','check_log','screenshot','file')),
 CONSTRAINT "task_artifacts_backend" CHECK ("storage_backend" IN ('fs')), CONSTRAINT "task_artifacts_state" CHECK ("upload_state" IN ('pending','confirmed','removed'))
);
--> statement-breakpoint
CREATE TABLE "run_checks" (
 "id" uuid PRIMARY KEY NOT NULL, "run_id" uuid CONSTRAINT "run_checks_run_id_task_runs_id_fk" REFERENCES "task_runs"("id") ON DELETE RESTRICT, "name" text, "command" text, "status" text,
 "not_run_reason" text, "exit_code" integer, "log_artifact_id" uuid CONSTRAINT "run_checks_log_artifact_id_task_artifacts_id_fk" REFERENCES "task_artifacts"("id") ON DELETE RESTRICT, "started_at" timestamptz, "finished_at" timestamptz,
 CONSTRAINT "run_checks_status" CHECK ("status" IN ('passed','failed','not_run'))
);
--> statement-breakpoint
-- Hand-written integrity and access rules.
CREATE FUNCTION af_0004_origin_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.origin_run_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM task_runs WHERE id = NEW.origin_run_id AND task_id = NEW.origin_task_id) THEN
  RAISE EXCEPTION 'origin run must belong to origin task';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER tasks_origin_run BEFORE INSERT OR UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION af_0004_origin_run();
CREATE FUNCTION af_0004_origin_run_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.task_id IS DISTINCT FROM OLD.task_id AND EXISTS (SELECT 1 FROM tasks WHERE origin_run_id = OLD.id AND origin_task_id IS DISTINCT FROM NEW.task_id) THEN
  RAISE EXCEPTION 'origin run must belong to origin task';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER task_runs_origin_guard BEFORE UPDATE OF task_id ON task_runs FOR EACH ROW EXECUTE FUNCTION af_0004_origin_run_update();
CREATE FUNCTION af_0004_run_role() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.engineer_run_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM task_runs WHERE id = NEW.engineer_run_id AND role = 'chief_engineer' AND task_id = NEW.task_id) THEN
  RAISE EXCEPTION 'engineer decision requires chief engineer run of task';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER task_decisions_run_role BEFORE INSERT OR UPDATE ON task_decisions FOR EACH ROW EXECUTE FUNCTION af_0004_run_role();
CREATE FUNCTION af_0004_artifact_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'artifacts cannot be deleted'; END IF;
 IF OLD.upload_state IN ('confirmed','removed') THEN
  IF (to_jsonb(NEW) - ARRAY['upload_state','removed_at','removed_by','updated_at','row_version']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['upload_state','removed_at','removed_by','updated_at','row_version']) OR
     (OLD.upload_state = 'removed' AND (NEW.upload_state IS DISTINCT FROM OLD.upload_state OR NEW.removed_at IS DISTINCT FROM OLD.removed_at OR NEW.removed_by IS DISTINCT FROM OLD.removed_by)) OR
     (OLD.upload_state = 'confirmed' AND NEW.upload_state IS DISTINCT FROM 'confirmed' AND NEW.upload_state IS DISTINCT FROM 'removed') OR
     (OLD.upload_state = 'confirmed' AND NEW.upload_state = 'confirmed' AND (NEW.removed_at IS DISTINCT FROM OLD.removed_at OR NEW.removed_by IS DISTINCT FROM OLD.removed_by)) THEN
   RAISE EXCEPTION 'confirmed artifact is immutable';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER task_artifacts_guard BEFORE UPDATE OR DELETE ON task_artifacts FOR EACH ROW EXECUTE FUNCTION af_0004_artifact_guard();
CREATE TRIGGER task_events_immutable BEFORE UPDATE OR DELETE ON task_events FOR EACH ROW EXECUTE FUNCTION af_refuse_immutable_change();
CREATE TRIGGER run_checks_immutable BEFORE UPDATE OR DELETE ON run_checks FOR EACH ROW EXECUTE FUNCTION af_refuse_immutable_change();
CREATE TRIGGER workspaces_no_delete BEFORE DELETE ON workspaces FOR EACH ROW EXECUTE FUNCTION af_refuse_delete();
CREATE TRIGGER task_runs_no_delete BEFORE DELETE ON task_runs FOR EACH ROW EXECUTE FUNCTION af_refuse_delete();
GRANT SELECT, INSERT ON workspaces, task_runs, task_events, task_artifacts, run_checks TO af_api, af_control;
GRANT UPDATE ON workspaces, task_artifacts TO af_api, af_control;
GRANT UPDATE ON task_runs TO af_control;
GRANT SELECT ON workspaces, task_runs, task_events, task_artifacts, run_checks TO af_backup;
GRANT USAGE, SELECT ON SEQUENCE task_events_seq_seq TO af_api, af_control;
GRANT SELECT ON SEQUENCE task_events_seq_seq TO af_backup;

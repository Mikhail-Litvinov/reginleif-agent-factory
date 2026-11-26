CREATE TABLE "task_dependencies" (
	"task_id" uuid NOT NULL,
	"depends_on_task_id" uuid NOT NULL,
	"dependency_type" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" bigint DEFAULT 1 NOT NULL,
	CONSTRAINT "task_dependencies_task_id_depends_on_task_id_pk" PRIMARY KEY("task_id","depends_on_task_id"),
	CONSTRAINT "task_dependencies_no_self" CHECK ("task_dependencies"."task_id" <> "task_dependencies"."depends_on_task_id"),
	CONSTRAINT "task_dependencies_type" CHECK ("task_dependencies"."dependency_type" = 'requires_accepted')
);
--> statement-breakpoint
CREATE TABLE "task_transitions" (
	"from_status" text NOT NULL,
	"to_status" text NOT NULL,
	CONSTRAINT "task_transitions_from_status_to_status_pk" PRIMARY KEY("from_status","to_status")
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid,
	"parent_task_id" uuid,
	"title" text,
	"description" text,
	"priority" integer,
	"status" text,
	"current_revision" integer,
	"created_by" uuid,
	"assigned_agent_id" uuid,
	"workflow_id" text,
	"workflow_run_id" text,
	"block_kind" text,
	"block_reason" text,
	"block_handler" text,
	"resume_to" text,
	"pause_requested" boolean,
	"stopping" boolean,
	"end_unconfirmed" boolean,
	"origin_type" text,
	"origin_task_id" uuid,
	"origin_run_id" uuid,
	"origin_actor" text,
	"depth" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"row_version" bigint DEFAULT 1 NOT NULL,
	CONSTRAINT "tasks_workflow_id_unique" UNIQUE("workflow_id"),
	CONSTRAINT "tasks_workflow_id" CHECK ("tasks"."workflow_id" = 'task-' || "tasks"."id"),
	CONSTRAINT "tasks_status" CHECK ("tasks"."status" IN ('CREATED','PLANNING','READY','WAITING_DEPENDENCIES','ASSIGNED','RUNNING','VERIFYING','AWAITING_APPROVAL','REWORK_REQUIRED','BLOCKED','ACCEPTED','REJECTED','CANCELLED','FAILED','PAUSED','CANCELLING')),
	CONSTRAINT "tasks_block_kind" CHECK ("tasks"."block_kind" IN ('scope','dependency','execution','usage_limit','agent_question','check_environment','rework_limit')),
	CONSTRAINT "tasks_block_handler" CHECK ("tasks"."block_handler" IN ('chief_engineer','owner')),
	CONSTRAINT "tasks_resume_to" CHECK ("tasks"."resume_to" IN ('CREATED','PLANNING','READY','WAITING_DEPENDENCIES','ASSIGNED','RUNNING','VERIFYING','AWAITING_APPROVAL','REWORK_REQUIRED','BLOCKED','ACCEPTED','REJECTED','CANCELLED','FAILED','PAUSED','CANCELLING')),
	CONSTRAINT "tasks_origin_type" CHECK ("tasks"."origin_type" IN ('owner','decomposition','agent_proposal','continuation','standing')),
	CONSTRAINT "tasks_block_kind_status" CHECK (("tasks"."status" = 'BLOCKED') = ("tasks"."block_kind" IS NOT NULL)),
	CONSTRAINT "tasks_block_handler_status" CHECK (("tasks"."status" = 'BLOCKED') = ("tasks"."block_handler" IS NOT NULL)),
	CONSTRAINT "tasks_resume_status" CHECK (("tasks"."status" = 'PAUSED') = ("tasks"."resume_to" IS NOT NULL)),
	CONSTRAINT "tasks_depth_root" CHECK (("tasks"."parent_task_id" IS NULL) = ("tasks"."depth" = 0)),
	CONSTRAINT "tasks_origin_required" CHECK ("tasks"."origin_type" NOT IN ('decomposition','agent_proposal') OR ("tasks"."origin_task_id" IS NOT NULL AND "tasks"."origin_run_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_depends_on_task_id_tasks_id_fk" FOREIGN KEY ("depends_on_task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_task_id_tasks_id_fk" FOREIGN KEY ("parent_task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assigned_agent_id_agents_id_fk" FOREIGN KEY ("assigned_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_origin_task_id_tasks_id_fk" FOREIGN KEY ("origin_task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_standing_project" ON "tasks" USING btree ("project_id") WHERE "tasks"."origin_type" = 'standing';
--> statement-breakpoint
-- Transition rows are generated from selectTransitionsForMigration('0002').
INSERT INTO task_transitions (from_status, to_status) VALUES
('CREATED','PLANNING'),
('PLANNING','READY'),
('PLANNING','BLOCKED'),
('PLANNING','FAILED'),
('READY','WAITING_DEPENDENCIES'),
('READY','ASSIGNED'),
('WAITING_DEPENDENCIES','ASSIGNED'),
('WAITING_DEPENDENCIES','BLOCKED'),
('ASSIGNED','RUNNING'),
('RUNNING','VERIFYING'),
('RUNNING','BLOCKED'),
('RUNNING','FAILED'),
('RUNNING','ASSIGNED'),
('VERIFYING','AWAITING_APPROVAL'),
('VERIFYING','REWORK_REQUIRED'),
('VERIFYING','BLOCKED'),
('VERIFYING','FAILED'),
('AWAITING_APPROVAL','ACCEPTED'),
('AWAITING_APPROVAL','REWORK_REQUIRED'),
('AWAITING_APPROVAL','REJECTED'),
('REWORK_REQUIRED','ASSIGNED'),
('CANCELLING','CANCELLED'),
('BLOCKED','PLANNING'),
('BLOCKED','READY'),
('BLOCKED','ASSIGNED'),
('BLOCKED','VERIFYING'),
('BLOCKED','REWORK_REQUIRED'),
('CREATED','CANCELLED'),
('CREATED','CANCELLING'),
('PLANNING','CANCELLED'),
('PLANNING','CANCELLING'),
('READY','CANCELLED'),
('READY','CANCELLING'),
('WAITING_DEPENDENCIES','CANCELLED'),
('WAITING_DEPENDENCIES','CANCELLING'),
('ASSIGNED','CANCELLED'),
('ASSIGNED','CANCELLING'),
('RUNNING','CANCELLED'),
('RUNNING','CANCELLING'),
('VERIFYING','CANCELLED'),
('VERIFYING','CANCELLING'),
('AWAITING_APPROVAL','CANCELLED'),
('AWAITING_APPROVAL','CANCELLING'),
('REWORK_REQUIRED','CANCELLED'),
('REWORK_REQUIRED','CANCELLING'),
('BLOCKED','CANCELLED'),
('BLOCKED','CANCELLING'),
('CREATED','PAUSED'),
('PLANNING','PAUSED'),
('READY','PAUSED'),
('WAITING_DEPENDENCIES','PAUSED'),
('ASSIGNED','PAUSED'),
('RUNNING','PAUSED'),
('VERIFYING','PAUSED'),
('AWAITING_APPROVAL','PAUSED'),
('REWORK_REQUIRED','PAUSED'),
('BLOCKED','PAUSED'),
('PAUSED','CREATED'),
('PAUSED','PLANNING'),
('PAUSED','READY'),
('PAUSED','WAITING_DEPENDENCIES'),
('PAUSED','ASSIGNED'),
('PAUSED','RUNNING'),
('PAUSED','VERIFYING'),
('PAUSED','AWAITING_APPROVAL'),
('PAUSED','REWORK_REQUIRED'),
('PAUSED','BLOCKED'),
('PAUSED','CANCELLED'),
('PAUSED','CANCELLING');

CREATE FUNCTION af_task_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_row tasks%ROWTYPE; limit_depth integer; project_deleted timestamptz;
BEGIN
 IF (NEW.block_kind IS NULL) <> (NEW.block_handler IS NULL) OR
    (NEW.status IS DISTINCT FROM 'BLOCKED' AND (NEW.block_kind IS NOT NULL OR NEW.block_handler IS NOT NULL)) THEN
   RAISE EXCEPTION 'block kind and handler require BLOCKED';
 END IF;
 IF NEW.project_id IS NOT NULL THEN
   SELECT deleted_at INTO project_deleted FROM projects WHERE id = NEW.project_id FOR UPDATE;
   IF project_deleted IS NOT NULL AND NEW.deleted_at IS NULL AND NEW.origin_type IS DISTINCT FROM 'standing'
      AND (NEW.status IS NULL OR NEW.status NOT IN ('ACCEPTED','REJECTED','CANCELLED','FAILED')) THEN
     RAISE EXCEPTION 'project is deleted';
   END IF;
 END IF;
 IF NEW.parent_task_id IS NULL THEN NEW.depth := 0;
 ELSE
   SELECT * INTO parent_row FROM tasks WHERE id = NEW.parent_task_id FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'parent task missing'; END IF;
   IF parent_row.project_id IS DISTINCT FROM NEW.project_id THEN RAISE EXCEPTION 'parent in different project'; END IF;
   NEW.depth := parent_row.depth + 1;
   SELECT max_child_depth INTO limit_depth FROM execution_policies
     WHERE project_id = NEW.project_id OR project_id IS NULL
     ORDER BY (project_id IS NOT NULL) DESC, version DESC NULLS LAST LIMIT 1;
   IF NEW.depth > limit_depth THEN RAISE EXCEPTION 'maximum child depth exceeded'; END IF;
 END IF;
 IF TG_OP = 'UPDATE' THEN
   IF OLD.status IS DISTINCT FROM NEW.status AND NOT EXISTS (SELECT 1 FROM task_transitions WHERE from_status = OLD.status AND to_status = NEW.status) THEN
     RAISE EXCEPTION 'illegal task transition';
   END IF;
   IF OLD.status = 'BLOCKED' AND NEW.status IS DISTINCT FROM 'BLOCKED' AND NEW.status IS DISTINCT FROM (CASE OLD.block_kind
       WHEN 'scope' THEN 'PLANNING' WHEN 'dependency' THEN 'READY' WHEN 'execution' THEN 'ASSIGNED'
       WHEN 'usage_limit' THEN 'ASSIGNED' WHEN 'agent_question' THEN 'ASSIGNED'
       WHEN 'check_environment' THEN 'VERIFYING' WHEN 'rework_limit' THEN 'REWORK_REQUIRED' END) THEN
     RAISE EXCEPTION 'invalid blocked target';
   END IF;
   IF OLD.status = 'BLOCKED' AND NEW.status = 'BLOCKED' AND
      (NEW.block_kind IS DISTINCT FROM OLD.block_kind OR (NEW.block_handler IS DISTINCT FROM OLD.block_handler AND NOT (OLD.block_handler = 'chief_engineer' AND NEW.block_handler = 'owner'))) THEN
     RAISE EXCEPTION 'invalid block handler change';
   END IF;
 END IF;
 IF NEW.status = 'BLOCKED' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'BLOCKED') AND NEW.block_kind IN ('scope','agent_question') AND NEW.block_handler IS DISTINCT FROM 'owner' THEN
   RAISE EXCEPTION 'block requires owner';
 END IF;
 IF NEW.deleted_at IS NOT NULL AND (NEW.origin_type = 'standing' OR NEW.status IS NULL OR NEW.status NOT IN ('ACCEPTED','REJECTED','CANCELLED','FAILED')) THEN RAISE EXCEPTION 'task cannot be deleted'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER tasks_guard BEFORE INSERT OR UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION af_task_guard();

CREATE FUNCTION af_dependency_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE project_a uuid; project_b uuid; found_cycle boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext('af-deps'));
 IF TG_OP = 'UPDATE' AND (NEW.task_id, NEW.depends_on_task_id, NEW.dependency_type, NEW.created_at)
    IS DISTINCT FROM (OLD.task_id, OLD.depends_on_task_id, OLD.dependency_type, OLD.created_at) THEN
   RAISE EXCEPTION 'immutable dependency fields cannot be changed';
 END IF;
 SELECT project_id INTO project_a FROM tasks WHERE id = NEW.task_id;
 SELECT project_id INTO project_b FROM tasks WHERE id = NEW.depends_on_task_id;
 IF project_a IS DISTINCT FROM project_b THEN RAISE EXCEPTION 'dependency crosses projects'; END IF;
 IF NEW.removed_at IS NULL THEN
   WITH RECURSIVE reachable(id) AS (
     SELECT NEW.depends_on_task_id UNION
     SELECT d.depends_on_task_id FROM task_dependencies d JOIN reachable r ON d.task_id = r.id
     WHERE d.removed_at IS NULL AND (d.task_id, d.depends_on_task_id) IS DISTINCT FROM (NEW.task_id, NEW.depends_on_task_id)
   ) SELECT EXISTS (SELECT 1 FROM reachable WHERE id = NEW.task_id) INTO found_cycle;
   IF found_cycle THEN RAISE EXCEPTION 'dependency_cycle'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER task_dependencies_guard BEFORE INSERT OR UPDATE ON task_dependencies FOR EACH ROW EXECUTE FUNCTION af_dependency_guard();
CREATE CONSTRAINT TRIGGER task_dependencies_cycle_backstop AFTER INSERT OR UPDATE ON task_dependencies DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION af_dependency_guard();
CREATE TRIGGER tasks_no_delete BEFORE DELETE ON tasks FOR EACH ROW EXECUTE FUNCTION af_refuse_delete();
CREATE TRIGGER task_dependencies_no_delete BEFORE DELETE ON task_dependencies FOR EACH ROW EXECUTE FUNCTION af_refuse_delete();
CREATE TRIGGER task_transitions_immutable BEFORE UPDATE OR DELETE ON task_transitions FOR EACH ROW EXECUTE FUNCTION af_refuse_immutable_change();
GRANT SELECT, INSERT ON tasks, task_dependencies TO af_api, af_control;
GRANT UPDATE (deleted_at, updated_at, row_version) ON tasks TO af_api;
GRANT UPDATE (status, current_revision, workflow_run_id, block_kind, block_reason, block_handler, resume_to, pause_requested, stopping, end_unconfirmed, assigned_agent_id, completed_at, deleted_at, updated_at, row_version) ON tasks TO af_control;
GRANT UPDATE (removed_at, removed_by, updated_at, row_version) ON task_dependencies TO af_api, af_control;
GRANT SELECT ON task_transitions TO af_api, af_control;
GRANT SELECT ON tasks, task_dependencies, task_transitions TO af_backup;

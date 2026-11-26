-- Rights tables and the nullable expand columns.
CREATE TABLE roles (
 id uuid PRIMARY KEY, name text, version integer, status text CHECK (status IN ('draft','active','superseded')),
 rights jsonb, deny jsonb, regulation_version_id uuid REFERENCES regulation_versions(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(), status_changed_at timestamptz, UNIQUE (name,version)
);
CREATE UNIQUE INDEX roles_active_name ON roles(name) WHERE status = 'active';
CREATE TABLE role_assignments (
 id uuid PRIMARY KEY, task_id uuid REFERENCES tasks(id) ON DELETE RESTRICT, participant text,
 role_id uuid REFERENCES roles(id) ON DELETE RESTRICT, assigned_by jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), superseded_at timestamptz
);
CREATE UNIQUE INDEX role_assignments_open ON role_assignments(task_id,participant) WHERE superseded_at IS NULL;
CREATE TABLE right_requests (
 id uuid PRIMARY KEY, task_id uuid REFERENCES tasks(id) ON DELETE RESTRICT, session_ref text,
 run_id uuid REFERENCES task_runs(id) ON DELETE RESTRICT, participant text, action text, target text,
 conditions jsonb, reason text, tried text, request_hash text,
 handling_task_id uuid REFERENCES tasks(id) ON DELETE RESTRICT, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK (task_id IS NOT NULL OR session_ref IS NOT NULL), CHECK (task_id IS NULL OR handling_task_id = task_id)
);
CREATE INDEX right_requests_repeat ON right_requests(task_id,request_hash);
CREATE TABLE right_answers (
 id uuid PRIMARY KEY, request_id uuid REFERENCES right_requests(id) ON DELETE RESTRICT, step integer,
 step_kind text CHECK (step_kind IN ('chief_engineer','code','owner')),
 answer text CHECK (answer IN ('grant','refuse','call_owner')), clause_id text, owner_act_ref text,
 reason text, answered_by jsonb, answer_run_id uuid REFERENCES task_runs(id) ON DELETE RESTRICT,
 inquiry_id uuid REFERENCES registry_inquiries(id) ON DELETE RESTRICT, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(request_id,step), CHECK (step_kind <> 'code' OR (answer <> 'grant' AND clause_id IS NULL)),
 CHECK (step_kind <> 'owner' OR answer <> 'call_owner'),
 CHECK ((step_kind = 'owner' AND answer = 'grant') = (owner_act_ref IS NOT NULL)),
 CHECK (step_kind <> 'chief_engineer' OR answer <> 'grant' OR clause_id IS NOT NULL)
);
CREATE TABLE rights_suspensions (
 id uuid PRIMARY KEY, agent_id uuid REFERENCES agents(id) ON DELETE RESTRICT,
 run_id uuid REFERENCES task_runs(id) ON DELETE RESTRICT, task_id uuid REFERENCES tasks(id) ON DELETE RESTRICT,
 session_ref text, event_key text UNIQUE, reason text, audit_id uuid REFERENCES audit_log(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz, restored_by jsonb, restore_reason text,
 restore_audit_id uuid REFERENCES audit_log(id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX rights_suspensions_open ON rights_suspensions(agent_id) WHERE ended_at IS NULL;
CREATE TABLE right_grants (
 id uuid PRIMARY KEY, request_id uuid UNIQUE REFERENCES right_requests(id) ON DELETE RESTRICT,
 answer_id uuid UNIQUE REFERENCES right_answers(id) ON DELETE RESTRICT, task_id uuid REFERENCES tasks(id) ON DELETE RESTRICT,
 session_ref text, participant text, role_assignment_id uuid REFERENCES role_assignments(id) ON DELETE RESTRICT,
 "right" jsonb, clause_id text, reason text, granted_by_run_id uuid REFERENCES task_runs(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz,
 ended_by text CHECK (ended_by IN ('task_end','session_end','revocation','critical')),
 revoked_by uuid REFERENCES owners(id) ON DELETE RESTRICT, suspension_id uuid REFERENCES rights_suspensions(id) ON DELETE RESTRICT,
 CHECK (task_id IS NOT NULL OR session_ref IS NOT NULL), CHECK ((ended_by = 'critical') = (suspension_id IS NOT NULL))
);
CREATE INDEX right_grants_open ON right_grants(task_id,participant) WHERE ended_at IS NULL;
ALTER TABLE task_runs ADD COLUMN participant text, ADD COLUMN role_assignment_id uuid REFERENCES role_assignments(id) ON DELETE RESTRICT, ADD COLUMN profile_rights jsonb;
ALTER TABLE task_runs DROP CONSTRAINT task_runs_role, ADD CONSTRAINT task_runs_role CHECK (role IN ('planner','implementer','tester','reviewer','chief_engineer'));
ALTER TABLE outbox_events DROP CONSTRAINT outbox_kind, ADD CONSTRAINT outbox_kind CHECK (kind IN ('start_workflow','deliver_decision','wake','notify','cleanup','stop_run'));
ALTER TABLE registry_records ADD COLUMN "right" jsonb, ADD COLUMN consumed_at timestamptz;
ALTER TABLE registry_records DROP CONSTRAINT registry_records_kind, DROP CONSTRAINT registry_records_owner_kind;
ALTER TABLE registry_records ADD CONSTRAINT registry_records_kind CHECK (kind IN ('rule','decision','exception','precedent','fact','permission')),
 ADD CONSTRAINT registry_records_owner_kind CHECK (authority = 'agent' OR kind IN ('rule','decision','exception','permission')),
 ADD CONSTRAINT registry_records_permission_authority CHECK (kind <> 'permission' OR authority = 'owner'),
 ADD CONSTRAINT registry_records_permission_source CHECK (kind <> 'permission' OR source = 'owner_button');

-- Hand-written guards and grants follow.
CREATE FUNCTION af_0007_valid_right(value jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT jsonb_typeof(value) = 'object' AND jsonb_typeof(value->'action') = 'string'
    AND jsonb_typeof(value->'target') = 'string' AND value ? 'conditions'
$$;
ALTER TABLE registry_records ADD CONSTRAINT registry_records_right CHECK ((kind = 'permission' AND af_0007_valid_right("right") IS TRUE) OR (kind IS DISTINCT FROM 'permission' AND "right" IS NULL));
ALTER TABLE right_grants ADD CONSTRAINT right_grants_right CHECK ("right" IS NULL OR af_0007_valid_right("right") IS TRUE);
CREATE FUNCTION af_0007_role_rights() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.rights IS NOT NULL AND (jsonb_typeof(NEW.rights) <> 'array' OR EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.rights) r WHERE af_0007_valid_right(r) IS NOT TRUE)) THEN RAISE EXCEPTION 'invalid role rights'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER roles_rights BEFORE INSERT OR UPDATE ON roles FOR EACH ROW EXECUTE FUNCTION af_0007_role_rights();
CREATE FUNCTION af_0007_answer_order() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE previous public.right_answers;
BEGIN
 IF (session_user = 'af_api' AND NEW.step_kind IS DISTINCT FROM 'owner') OR (session_user = 'af_control' AND NEW.step_kind = 'owner') THEN RAISE EXCEPTION 'answer not permitted for role'; END IF;
 PERFORM 1 FROM public.right_requests WHERE id = NEW.request_id FOR UPDATE;
 SELECT * INTO previous FROM public.right_answers WHERE request_id = NEW.request_id ORDER BY step DESC LIMIT 1;
 IF previous.id IS NULL THEN
  IF NEW.step IS DISTINCT FROM 1 OR (NEW.step_kind IN ('code','chief_engineer')) IS NOT TRUE THEN RAISE EXCEPTION 'invalid first answer'; END IF;
 ELSIF NEW.step IS DISTINCT FROM previous.step + 1 OR previous.answer IS DISTINCT FROM 'call_owner' OR NEW.step_kind IS DISTINCT FROM 'owner' THEN
  RAISE EXCEPTION 'invalid answer order';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER right_answers_order BEFORE INSERT ON right_answers FOR EACH ROW EXECUTE FUNCTION af_0007_answer_order();
CREATE FUNCTION af_0007_grant_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a right_answers; r right_requests; task_status text;
BEGIN
 SELECT * INTO a FROM right_answers WHERE id = NEW.answer_id;
 SELECT * INTO r FROM right_requests WHERE id = NEW.request_id;
 IF a.answer IS DISTINCT FROM 'grant' OR a.request_id IS DISTINCT FROM NEW.request_id OR
    (a.step_kind = 'owner') IS DISTINCT FROM (NEW.clause_id IS NULL) OR
    (a.step_kind = 'owner') IS DISTINCT FROM (NEW.granted_by_run_id IS NULL) OR
    (a.step_kind = 'chief_engineer' AND (NEW.clause_id IS DISTINCT FROM a.clause_id OR NEW.granted_by_run_id IS DISTINCT FROM a.answer_run_id)) OR
    NEW.task_id IS DISTINCT FROM r.task_id OR NEW.session_ref IS DISTINCT FROM r.session_ref OR NEW.participant IS DISTINCT FROM r.participant THEN RAISE EXCEPTION 'grant requires matching grant answer and request'; END IF;
 -- A concurrent task ending or suspension must either see the new grant or prevent it.
 SELECT status INTO task_status FROM tasks WHERE id = NEW.task_id FOR SHARE;
 IF NEW.ended_at IS NULL AND task_status IN ('ACCEPTED','REJECTED','CANCELLED','FAILED') THEN RAISE EXCEPTION 'grant task has ended'; END IF;
 PERFORM 1 FROM agents agent JOIN task_runs requester ON requester.agent_id = agent.id WHERE requester.id = r.run_id FOR UPDATE OF agent;
 IF EXISTS (SELECT 1 FROM task_runs run JOIN rights_suspensions s ON s.agent_id = run.agent_id AND s.ended_at IS NULL WHERE run.id = r.run_id) THEN RAISE EXCEPTION 'requesting agent suspended'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER right_grants_answer BEFORE INSERT ON right_grants FOR EACH ROW EXECUTE FUNCTION af_0007_grant_guard();
CREATE TRIGGER right_requests_immutable BEFORE UPDATE OR DELETE ON right_requests FOR EACH ROW EXECUTE FUNCTION af_refuse_immutable_change();
CREATE TRIGGER right_answers_immutable BEFORE UPDATE OR DELETE ON right_answers FOR EACH ROW EXECUTE FUNCTION af_refuse_immutable_change();
CREATE TRIGGER role_assignments_content BEFORE UPDATE OR DELETE ON role_assignments FOR EACH ROW EXECUTE FUNCTION af_0003_guard_content('{superseded_at}', '{superseded_at}');
CREATE TRIGGER right_grants_content BEFORE UPDATE OR DELETE ON right_grants FOR EACH ROW EXECUTE FUNCTION af_0003_guard_content('{ended_at,ended_by,revoked_by,suspension_id}', '{ended_at,ended_by,revoked_by,suspension_id}');
CREATE TRIGGER rights_suspensions_content BEFORE UPDATE OR DELETE ON rights_suspensions FOR EACH ROW EXECUTE FUNCTION af_0003_guard_content('{ended_at,restored_by,restore_reason,restore_audit_id}', '{ended_at,restored_by,restore_reason,restore_audit_id}');
CREATE TRIGGER roles_content BEFORE UPDATE OR DELETE ON roles FOR EACH ROW EXECUTE FUNCTION af_0003_guard_content('{status,status_changed_at}', '{}');
CREATE FUNCTION af_0007_role_status() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE expected text; previous integer;
BEGIN
 PERFORM 1 FROM public.regulation_versions WHERE id = NEW.regulation_version_id FOR UPDATE;
 SELECT CASE status WHEN 'revoked' THEN 'superseded' ELSE status END INTO expected FROM public.regulation_versions WHERE id = NEW.regulation_version_id;
 IF NEW.regulation_version_id IS NOT NULL AND NEW.status IS DISTINCT FROM expected THEN RAISE EXCEPTION 'role status must follow regulation'; END IF;
 IF TG_OP = 'INSERT' THEN
  IF NEW.name IS NOT NULL AND NEW.version IS NOT NULL THEN
   PERFORM pg_advisory_xact_lock(hashtext(NEW.name));
   SELECT coalesce(max(version),0) INTO previous FROM public.roles WHERE name = NEW.name;
   IF NEW.version IS DISTINCT FROM previous + 1 THEN RAISE EXCEPTION 'role versions must be contiguous'; END IF;
  END IF;
 ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
  INSERT INTO public.audit_log(id,action,target_type,target_id,outcome,details) VALUES (gen_random_uuid(),'role.status','roles',NEW.id,'ok',jsonb_build_object('old_status',OLD.status,'new_status',NEW.status));
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER roles_status BEFORE INSERT OR UPDATE ON roles FOR EACH ROW EXECUTE FUNCTION af_0007_role_status();
CREATE FUNCTION af_0007_regulation_roles() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
 IF NEW.status IS DISTINCT FROM OLD.status THEN
  UPDATE public.roles SET status = CASE NEW.status WHEN 'revoked' THEN 'superseded' ELSE NEW.status END, status_changed_at = NEW.status_changed_at WHERE regulation_version_id = NEW.id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER regulation_roles AFTER UPDATE OF status ON regulation_versions FOR EACH ROW EXECUTE FUNCTION af_0007_regulation_roles();
CREATE FUNCTION af_0007_run_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.agent_id IS NOT NULL THEN PERFORM 1 FROM agents WHERE id = NEW.agent_id FOR UPDATE; END IF;
 IF EXISTS (SELECT 1 FROM rights_suspensions WHERE agent_id = NEW.agent_id AND ended_at IS NULL) THEN RAISE EXCEPTION 'agent suspended'; END IF;
 IF NEW.role = 'chief_engineer' AND (NEW.role_assignment_id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM right_requests WHERE handling_task_id = NEW.task_id) AND NOT EXISTS (SELECT 1 FROM tasks WHERE id = NEW.task_id AND status = 'BLOCKED' AND block_handler = 'chief_engineer')) THEN RAISE EXCEPTION 'chief engineer run requires request or block'; END IF;
 IF EXISTS (SELECT 1 FROM tasks WHERE id = NEW.task_id AND origin_type = 'standing') AND (NEW.role IS DISTINCT FROM 'chief_engineer' OR NEW.participant IS NULL) THEN RAISE EXCEPTION 'standing task requires chief engineer participant'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER task_runs_rights BEFORE INSERT ON task_runs FOR EACH ROW EXECUTE FUNCTION af_0007_run_guard();
CREATE FUNCTION af_0007_suspension_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.agent_id IS NOT NULL THEN PERFORM 1 FROM agents WHERE id = NEW.agent_id FOR UPDATE; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER rights_suspensions_lock BEFORE INSERT ON rights_suspensions FOR EACH ROW EXECUTE FUNCTION af_0007_suspension_lock();
CREATE FUNCTION af_0007_restore_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor_run task_runs;
BEGIN
 IF NEW.ended_at IS DISTINCT FROM OLD.ended_at THEN
  IF NEW.restored_by->>'type' = 'run' THEN
   SELECT * INTO actor_run FROM task_runs WHERE id::text = NEW.restored_by->>'id';
   IF actor_run.id IS NULL OR actor_run.role IS DISTINCT FROM 'chief_engineer' OR actor_run.agent_id = NEW.agent_id OR EXISTS (SELECT 1 FROM rights_suspensions WHERE agent_id = actor_run.agent_id AND ended_at IS NULL) OR EXISTS (SELECT 1 FROM task_runs WHERE id = NEW.run_id AND agent_id = NEW.agent_id AND role = 'chief_engineer') THEN RAISE EXCEPTION 'invalid restore actor'; END IF;
  ELSIF NEW.restored_by->>'type' = 'owner' THEN
   IF NOT EXISTS (SELECT 1 FROM owners WHERE id::text = NEW.restored_by->>'id') OR NOT EXISTS (SELECT 1 FROM task_runs WHERE id = NEW.run_id AND agent_id = NEW.agent_id AND role = 'chief_engineer') THEN RAISE EXCEPTION 'owner restore requires chief engineer subject'; END IF;
  ELSE RAISE EXCEPTION 'invalid restore actor'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER rights_suspensions_restore BEFORE UPDATE ON rights_suspensions FOR EACH ROW EXECUTE FUNCTION af_0007_restore_guard();
CREATE FUNCTION af_0007_answer_grant() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.right_requests; assignment uuid; confirmation public.confirmations;
BEGIN
 IF NEW.answer IS DISTINCT FROM 'grant' THEN RETURN NEW; END IF;
 SELECT * INTO r FROM public.right_requests WHERE id = NEW.request_id;
 IF NEW.step_kind = 'owner' THEN
  SELECT * INTO confirmation FROM public.confirmations WHERE id::text = NEW.owner_act_ref FOR UPDATE;
  IF confirmation.id IS NULL OR confirmation.actor_id IS NULL OR confirmation.target_id IS DISTINCT FROM r.id OR confirmation.request_hash IS DISTINCT FROM r.request_hash OR confirmation.used_at IS NOT NULL OR confirmation.expires_at IS NULL OR confirmation.expires_at <= now() THEN RAISE EXCEPTION 'invalid owner confirmation'; END IF;
  UPDATE public.confirmations SET used_at = now(), updated_at = now(), row_version = row_version + 1 WHERE id = confirmation.id;
 ELSE
  IF NOT EXISTS (SELECT 1 FROM public.task_runs run WHERE run.id = NEW.answer_run_id AND run.role = 'chief_engineer' AND run.task_id = r.handling_task_id AND run.id IS DISTINCT FROM r.run_id AND NOT EXISTS (SELECT 1 FROM public.rights_suspensions s WHERE s.agent_id = run.agent_id AND s.ended_at IS NULL)) THEN RAISE EXCEPTION 'grant requires independent chief engineer run'; END IF;
 END IF;
 SELECT role_assignment_id INTO assignment FROM public.task_runs WHERE id = r.run_id;
 INSERT INTO public.right_grants(id,request_id,answer_id,task_id,session_ref,participant,role_assignment_id,"right",clause_id,reason,granted_by_run_id)
 VALUES (gen_random_uuid(),r.id,NEW.id,r.task_id,r.session_ref,r.participant,assignment,jsonb_build_object('action',r.action,'target',r.target,'conditions',r.conditions),NEW.clause_id,NEW.reason,CASE WHEN NEW.step_kind = 'owner' THEN NULL ELSE NEW.answer_run_id END);
 RETURN NEW;
END $$;
CREATE TRIGGER right_answers_grant AFTER INSERT ON right_answers FOR EACH ROW EXECUTE FUNCTION af_0007_answer_grant();
CREATE FUNCTION af_0007_rights_audit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE action_name text;
BEGIN
 action_name := CASE TG_TABLE_NAME WHEN 'right_requests' THEN 'right.request' WHEN 'right_answers' THEN 'right.answer' WHEN 'right_grants' THEN CASE WHEN TG_OP = 'INSERT' THEN 'right.grant' ELSE 'right.revoke' END WHEN 'rights_suspensions' THEN CASE WHEN TG_OP = 'INSERT' THEN 'rights.suspend' ELSE 'rights.restore' END END;
 IF TG_OP = 'UPDATE' AND to_jsonb(NEW) IS NOT DISTINCT FROM to_jsonb(OLD) THEN RETURN NEW; END IF;
 INSERT INTO public.audit_log(id,action,target_type,target_id,outcome,details) VALUES (gen_random_uuid(),action_name,TG_TABLE_NAME,NEW.id,'ok',jsonb_build_object('new',to_jsonb(NEW)));
 RETURN NEW;
END $$;
CREATE TRIGGER right_requests_audit AFTER INSERT ON right_requests FOR EACH ROW EXECUTE FUNCTION af_0007_rights_audit();
CREATE TRIGGER right_answers_audit AFTER INSERT ON right_answers FOR EACH ROW EXECUTE FUNCTION af_0007_rights_audit();
CREATE TRIGGER right_grants_audit AFTER INSERT OR UPDATE ON right_grants FOR EACH ROW EXECUTE FUNCTION af_0007_rights_audit();
CREATE TRIGGER rights_suspensions_audit AFTER INSERT OR UPDATE ON rights_suspensions FOR EACH ROW EXECUTE FUNCTION af_0007_rights_audit();
CREATE FUNCTION af_0007_run_profile() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.profile_rights IS NOT NULL AND NEW.profile_rights IS DISTINCT FROM OLD.profile_rights THEN RAISE EXCEPTION 'run profile is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER task_runs_profile BEFORE UPDATE ON task_runs FOR EACH ROW EXECUTE FUNCTION af_0007_run_profile();
CREATE FUNCTION af_0007_standing_task() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.origin_type = 'standing' AND (NEW.status IS DISTINCT FROM 'RUNNING' OR NEW.completed_at IS NOT NULL OR NEW.deleted_at IS NOT NULL) THEN RAISE EXCEPTION 'invalid standing task'; END IF;
 IF TG_OP = 'UPDATE' AND OLD.origin_type = 'standing' AND NEW.origin_type IS DISTINCT FROM 'standing' THEN RAISE EXCEPTION 'standing task is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER tasks_standing BEFORE INSERT OR UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION af_0007_standing_task();
CREATE FUNCTION af_0007_standing_related() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS (SELECT 1 FROM tasks WHERE id = NEW.task_id AND origin_type = 'standing') THEN
  IF TG_TABLE_NAME = 'workspaces' OR (TG_TABLE_NAME = 'task_revisions' AND (to_jsonb(NEW)->>'revision_number')::integer > 1) OR (TG_TABLE_NAME = 'task_decisions' AND to_jsonb(NEW)->>'kind' IS DISTINCT FROM 'physical_decision') OR (TG_TABLE_NAME = 'outbox_events' AND to_jsonb(NEW)->>'kind' = 'start_workflow') THEN RAISE EXCEPTION 'invalid standing task operation'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER workspaces_standing BEFORE INSERT OR UPDATE ON workspaces FOR EACH ROW EXECUTE FUNCTION af_0007_standing_related();
CREATE TRIGGER task_revisions_standing BEFORE INSERT OR UPDATE ON task_revisions FOR EACH ROW EXECUTE FUNCTION af_0007_standing_related();
CREATE TRIGGER task_decisions_standing BEFORE INSERT OR UPDATE ON task_decisions FOR EACH ROW EXECUTE FUNCTION af_0007_standing_related();
CREATE TRIGGER outbox_standing BEFORE INSERT OR UPDATE ON outbox_events FOR EACH ROW EXECUTE FUNCTION af_0007_standing_related();
CREATE FUNCTION af_0007_run_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS (SELECT 1 FROM task_runs WHERE id = NEW.run_id AND role = 'chief_engineer') THEN RAISE EXCEPTION 'chief engineer cannot write artifact'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER task_artifacts_engineer BEFORE INSERT OR UPDATE ON task_artifacts FOR EACH ROW EXECUTE FUNCTION af_0007_run_artifact();
CREATE FUNCTION af_0007_consumption_audit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
 IF NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
  INSERT INTO public.audit_log(id,action,target_type,target_id,outcome,details) VALUES (gen_random_uuid(),'registry.status','registry_records',NEW.id,'ok',jsonb_build_object('consumed_at',NEW.consumed_at));
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER registry_records_consumption_audit AFTER UPDATE OF consumed_at ON registry_records FOR EACH ROW EXECUTE FUNCTION af_0007_consumption_audit();
CREATE FUNCTION af_0007_enqueue_stops(source_id uuid DEFAULT NULL, role_source boolean DEFAULT false,
 assignment_id uuid DEFAULT NULL, suspended_agent uuid DEFAULT NULL) RETURNS void
 LANGUAGE sql SET search_path = pg_catalog, public AS $$
 INSERT INTO public.outbox_events(id,kind,task_id,payload,state,attempts)
 -- Several rights can end together, including grants closed by the suspension trigger.
 SELECT md5('af_0007:stop_run:' || pg_current_xact_id()::text || ':' || run.id::text)::uuid,
        'stop_run', run.task_id, jsonb_build_object('run_id',run.id,'execution_id',run.execution_id), 'pending', 0
 FROM public.task_runs run
 LEFT JOIN public.role_assignments assignment ON assignment.id = run.role_assignment_id
 WHERE run.execution_id IS NOT NULL AND run.finished_at IS NULL
   AND (run.status IS NULL OR run.status NOT IN ('finished','failed','died','cancelled'))
   AND (assignment_id IS NULL OR run.role_assignment_id = assignment_id)
   AND (run.agent_id = suspended_agent
        OR (source_id IS NOT NULL AND run.profile_rights @> jsonb_build_array(jsonb_build_object('source',source_id)))
        OR (role_source AND run.profile_rights @> '[{"source":"role"}]'::jsonb
            AND (assignment_id IS NOT NULL OR assignment.role_id = source_id)))
 ON CONFLICT (id) DO NOTHING;
$$;
REVOKE EXECUTE ON FUNCTION af_0007_enqueue_stops(uuid,boolean,uuid,uuid) FROM PUBLIC;

CREATE FUNCTION af_0007_stop_on_right_end() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
 CASE TG_TABLE_NAME
  WHEN 'right_grants', 'registry_records' THEN
   PERFORM public.af_0007_enqueue_stops(source_id => NEW.id);
  WHEN 'roles' THEN
   PERFORM public.af_0007_enqueue_stops(source_id => NEW.id, role_source => true);
  WHEN 'role_assignments' THEN
   PERFORM public.af_0007_enqueue_stops(source_id => NEW.role_id, role_source => true, assignment_id => NEW.id);
  WHEN 'tasks' THEN
   UPDATE public.right_grants SET ended_at = now(), ended_by = 'task_end'
   WHERE task_id = NEW.id AND ended_at IS NULL;
  WHEN 'rights_suspensions' THEN
   UPDATE public.right_grants grant_row
   SET ended_at = now(), ended_by = 'critical', suspension_id = NEW.id
   WHERE grant_row.ended_at IS NULL AND (
    grant_row.session_ref = NEW.session_ref OR EXISTS (
     SELECT 1 FROM public.right_requests request
     JOIN public.task_runs requester ON requester.id = request.run_id
     WHERE request.id = grant_row.request_id AND requester.agent_id = NEW.agent_id
    )
   );
   PERFORM public.af_0007_enqueue_stops(suspended_agent => NEW.agent_id);
 END CASE;
 RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION af_0007_stop_on_right_end() FROM PUBLIC;

CREATE TRIGGER right_grants_stop AFTER UPDATE OF ended_at ON right_grants FOR EACH ROW
 WHEN (OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL) EXECUTE FUNCTION af_0007_stop_on_right_end();
CREATE TRIGGER registry_permission_stop AFTER UPDATE OF status ON registry_records FOR EACH ROW
 WHEN (OLD.kind = 'permission' AND OLD.status = 'active' AND NEW.status = 'revoked') EXECUTE FUNCTION af_0007_stop_on_right_end();
CREATE TRIGGER roles_stop AFTER UPDATE OF status ON roles FOR EACH ROW
 WHEN (OLD.status = 'active' AND NEW.status = 'superseded') EXECUTE FUNCTION af_0007_stop_on_right_end();
CREATE TRIGGER role_assignments_stop AFTER UPDATE OF superseded_at ON role_assignments FOR EACH ROW
 WHEN (OLD.superseded_at IS NULL AND NEW.superseded_at IS NOT NULL) EXECUTE FUNCTION af_0007_stop_on_right_end();
CREATE TRIGGER tasks_end_grants AFTER UPDATE OF status ON tasks FOR EACH ROW
 WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status IN ('ACCEPTED','REJECTED','CANCELLED','FAILED'))
 EXECUTE FUNCTION af_0007_stop_on_right_end();
CREATE TRIGGER rights_suspensions_stop AFTER INSERT ON rights_suspensions FOR EACH ROW
 WHEN (NEW.ended_at IS NULL) EXECUTE FUNCTION af_0007_stop_on_right_end();

CREATE OR REPLACE FUNCTION af_0006_record_content() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'registry_records is immutable'; END IF;
 IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN RAISE EXCEPTION 'consumed_at is set once'; END IF;
 IF NEW.consumed_at IS DISTINCT FROM OLD.consumed_at AND (NEW.kind IS DISTINCT FROM 'permission' OR NEW.reuse IS DISTINCT FROM 'once') THEN RAISE EXCEPTION 'only once permissions can be consumed'; END IF;
 IF (to_jsonb(NEW) - ARRAY['status','status_changed_at','status_changed_by','consumed_at','search_ru','search_en']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','status_changed_at','status_changed_by','consumed_at','search_ru','search_en']) THEN RAISE EXCEPTION 'registry_records content is immutable'; END IF;
 RETURN NEW;
END $$;
-- database.md (rights tables): af_api has select and insert on all six; af_control reads them and inserts requests,
-- answers, grants and the suspension row, and sets the ending columns of grants; it inserts no role and no assignment.
GRANT SELECT, INSERT ON roles, role_assignments, right_requests, right_answers, rights_suspensions, right_grants TO af_api;
GRANT SELECT ON roles, role_assignments, right_requests, right_answers, rights_suspensions, right_grants TO af_control;
GRANT INSERT ON right_requests, right_answers, right_grants, rights_suspensions TO af_control;
GRANT UPDATE (status,status_changed_at) ON roles TO af_api;
GRANT UPDATE (superseded_at) ON role_assignments TO af_api;
GRANT UPDATE (ended_at,ended_by,revoked_by,suspension_id) ON right_grants TO af_api, af_control;
GRANT UPDATE (ended_at,restored_by,restore_reason,restore_audit_id) ON rights_suspensions TO af_api;
GRANT UPDATE (consumed_at) ON registry_records TO af_api;
GRANT SELECT ON roles, role_assignments, right_requests, right_answers, rights_suspensions, right_grants TO af_backup;
INSERT INTO projects(id,name) VALUES ('00000000-0000-4000-8000-000000000007','_factory') ON CONFLICT DO NOTHING;
INSERT INTO tasks(id,project_id,title,status,origin_type,depth,workflow_id) VALUES ('00000000-0000-4000-8000-000000000008','00000000-0000-4000-8000-000000000007','Factory standing task','RUNNING','standing',0,'task-00000000-0000-4000-8000-000000000008') ON CONFLICT DO NOTHING;

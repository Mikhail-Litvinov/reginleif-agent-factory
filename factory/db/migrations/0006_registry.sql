-- pg_trgm is trusted and created here under af_migrator. vector (pgvector) is not trusted:
-- deploy/postgres/init/10-roles.sh creates it as the superuser at database initialization.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE TABLE regulation_versions (
 id uuid PRIMARY KEY,
 number integer,
 status text,
 clauses jsonb,
 clauses_bytes integer,
 basis_version_id uuid,
 proposed_by jsonb,
 conflict_report jsonb,
 confirmed_by uuid,
 confirmation_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 activated_at timestamptz,
 status_changed_at timestamptz,
 CONSTRAINT regulation_versions_number_unique UNIQUE (number),
 CONSTRAINT regulation_versions_status CHECK (status IN ('draft','active','superseded','revoked')),
 CONSTRAINT regulation_versions_basis_version_id_regulation_versions_id_fk FOREIGN KEY (basis_version_id) REFERENCES regulation_versions(id) ON DELETE RESTRICT,
 CONSTRAINT regulation_versions_confirmed_by_owners_id_fk FOREIGN KEY (confirmed_by) REFERENCES owners(id) ON DELETE RESTRICT,
 CONSTRAINT regulation_versions_confirmation_id_confirmations_id_fk FOREIGN KEY (confirmation_id) REFERENCES confirmations(id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX regulation_versions_one_active ON regulation_versions (status) WHERE status = 'active';
--> statement-breakpoint
ALTER TABLE api_tokens DROP CONSTRAINT api_tokens_role;
ALTER TABLE api_tokens ADD CONSTRAINT api_tokens_role CHECK (role IN ('owner','worker','relay','reader','registry','hub'));
ALTER TABLE api_tokens ADD COLUMN session_ref text, ADD COLUMN run_id uuid;
ALTER TABLE api_tokens ADD CONSTRAINT api_tokens_run_id_task_runs_id_fk FOREIGN KEY (run_id) REFERENCES task_runs(id) ON DELETE RESTRICT;
ALTER TABLE api_tokens ADD CONSTRAINT api_tokens_registry_binding CHECK (role <> 'registry' OR session_ref IS NOT NULL OR run_id IS NOT NULL);
ALTER TABLE task_runs ADD COLUMN regulation_version_id uuid, ADD COLUMN regulation_seen_id uuid;
ALTER TABLE task_runs ADD CONSTRAINT task_runs_regulation_version_id_regulation_versions_id_fk FOREIGN KEY (regulation_version_id) REFERENCES regulation_versions(id) ON DELETE RESTRICT;
ALTER TABLE task_runs ADD CONSTRAINT task_runs_regulation_seen_id_regulation_versions_id_fk FOREIGN KEY (regulation_seen_id) REFERENCES regulation_versions(id) ON DELETE RESTRICT;
--> statement-breakpoint
CREATE TABLE registry_inquiries (
 id uuid PRIMARY KEY,
 number bigint GENERATED ALWAYS AS IDENTITY,
 token_id uuid,
 session_ref text,
 run_id uuid,
 project_id uuid,
 problem text,
 category text,
 action text,
 target text,
 reuse_intent text DEFAULT 'once',
 regulation_version_id uuid,
 poll_question text,
 poll_options jsonb,
 poll_registered_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT registry_inquiries_number_unique UNIQUE (number),
 CONSTRAINT registry_inquiries_reuse CHECK (reuse_intent IN ('standing','once')),
 CONSTRAINT registry_inquiries_token_id_api_tokens_id_fk FOREIGN KEY (token_id) REFERENCES api_tokens(id) ON DELETE RESTRICT,
 CONSTRAINT registry_inquiries_run_id_task_runs_id_fk FOREIGN KEY (run_id) REFERENCES task_runs(id) ON DELETE RESTRICT,
 CONSTRAINT registry_inquiries_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT,
 CONSTRAINT registry_inquiries_regulation_version_id_regulation_versions_id_fk FOREIGN KEY (regulation_version_id) REFERENCES regulation_versions(id) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE registry_records (
 id uuid PRIMARY KEY,
 number bigint GENERATED ALWAYS AS IDENTITY,
 kind text,
 authority text,
 status text,
 scope_type text,
 project_id uuid,
 repository text,
 machine_id text,
 action text,
 target text,
 category text,
 problem text,
 decision text,
 exceptions_text text,
 grounds text,
 consequences text,
 reuse text,
 version integer DEFAULT 1,
 question text,
 options jsonb,
 pressed_option text,
 summary text,
 tags text[],
 evidence jsonb,
 source text,
 source_ref text,
 press_id text,
 poll_option integer,
 inquiry_id uuid,
 run_id uuid,
 created_by jsonb,
 search_ru tsvector GENERATED ALWAYS AS (to_tsvector('russian'::regconfig, coalesce(problem,'') || ' ' || coalesce(decision,'') || ' ' || coalesce(exceptions_text,'') || ' ' || coalesce(grounds,'') || ' ' || coalesce(consequences,'') || ' ' || coalesce(question,'') || ' ' || coalesce(summary,''))) STORED,
 search_en tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, coalesce(problem,'') || ' ' || coalesce(decision,'') || ' ' || coalesce(exceptions_text,'') || ' ' || coalesce(grounds,'') || ' ' || coalesce(consequences,'') || ' ' || coalesce(question,'') || ' ' || coalesce(summary,''))) STORED,
 created_at timestamptz NOT NULL DEFAULT now(),
 status_changed_at timestamptz,
 status_changed_by jsonb,
 CONSTRAINT registry_records_number_unique UNIQUE (number),
 CONSTRAINT registry_records_scope CHECK ((scope_type = 'project') = (project_id IS NOT NULL)),
 CONSTRAINT registry_records_press CHECK ((source = 'poll_press') = (pressed_option IS NOT NULL)),
 CONSTRAINT registry_records_kind CHECK (kind IN ('rule','decision','exception','precedent','fact')),
 CONSTRAINT registry_records_authority CHECK (authority IN ('owner','agent')),
 CONSTRAINT registry_records_status CHECK (status IN ('draft','active','superseded','revoked','rejected')),
 CONSTRAINT registry_records_scope_type CHECK (scope_type IN ('global','project')),
 CONSTRAINT registry_records_reuse CHECK (reuse IN ('standing','once')),
 CONSTRAINT registry_records_source CHECK (source IN ('poll_press','owner_button','owner_message','orchestrator','agent_proposal','import')),
 CONSTRAINT registry_records_owner_kind CHECK (authority = 'agent' OR kind IN ('rule','decision','exception')),
 CONSTRAINT registry_records_precedent CHECK (kind <> 'precedent' OR authority = 'agent'),
 CONSTRAINT registry_records_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT,
 CONSTRAINT registry_records_inquiry_id_registry_inquiries_id_fk FOREIGN KEY (inquiry_id) REFERENCES registry_inquiries(id) ON DELETE RESTRICT,
 CONSTRAINT registry_records_run_id_task_runs_id_fk FOREIGN KEY (run_id) REFERENCES task_runs(id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX registry_records_press_id ON registry_records (press_id) WHERE press_id IS NOT NULL;
CREATE INDEX registry_records_search_ru ON registry_records USING gin (search_ru);
CREATE INDEX registry_records_search_en ON registry_records USING gin (search_en);
CREATE INDEX registry_records_problem_trgm ON registry_records USING gin (problem gin_trgm_ops);
CREATE INDEX registry_records_decision_trgm ON registry_records USING gin (decision gin_trgm_ops);
CREATE INDEX registry_records_filters ON registry_records (status, scope_type, project_id, category);
--> statement-breakpoint
CREATE TABLE registry_links (
 id uuid PRIMARY KEY,
 from_record_id uuid,
 to_record_id uuid,
 link_type text,
 created_by jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT registry_links_unique UNIQUE (from_record_id, to_record_id, link_type),
 CONSTRAINT registry_links_distinct CHECK (from_record_id <> to_record_id),
 CONSTRAINT registry_links_type CHECK (link_type IN ('supersedes','exception_to','evidence','conflicts_with')),
 CONSTRAINT registry_links_from_record_id_registry_records_id_fk FOREIGN KEY (from_record_id) REFERENCES registry_records(id) ON DELETE RESTRICT,
 CONSTRAINT registry_links_to_record_id_registry_records_id_fk FOREIGN KEY (to_record_id) REFERENCES registry_records(id) ON DELETE RESTRICT
);
CREATE TABLE registry_embeddings (
 id uuid PRIMARY KEY,
 record_id uuid,
 model_version text,
 dimensions integer,
 embedding vector(1024),
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT registry_embeddings_model UNIQUE (record_id, model_version),
 CONSTRAINT registry_embeddings_record_id_registry_records_id_fk FOREIGN KEY (record_id) REFERENCES registry_records(id) ON DELETE RESTRICT
);
CREATE INDEX registry_embeddings_cosine ON registry_embeddings USING hnsw (embedding vector_cosine_ops);
CREATE TABLE registry_inquiry_results (
 id uuid PRIMARY KEY,
 inquiry_id uuid,
 record_id uuid,
 record_version integer,
 found_by text,
 ranking text,
 score numeric,
 matched_fields jsonb,
 verdict text,
 difference text,
 conflicts_with_id uuid,
 verdict_at timestamptz,
 CONSTRAINT registry_results_inquiry_record UNIQUE (inquiry_id, record_id),
 CONSTRAINT registry_results_found_by CHECK (found_by IN ('inquiry','gate')),
 CONSTRAINT registry_results_ranking CHECK (ranking IN ('fulltext','trigram','vector')),
 CONSTRAINT registry_results_verdict CHECK (verdict IN ('applies','not_applicable','outdated','conflict')),
 CONSTRAINT registry_results_difference CHECK (verdict IS NULL OR verdict = 'applies' OR difference IS NOT NULL),
 CONSTRAINT registry_results_conflict CHECK (verdict IS DISTINCT FROM 'conflict' OR conflicts_with_id IS NOT NULL),
 CONSTRAINT registry_inquiry_results_inquiry_id_registry_inquiries_id_fk FOREIGN KEY (inquiry_id) REFERENCES registry_inquiries(id) ON DELETE RESTRICT,
 CONSTRAINT registry_inquiry_results_record_id_registry_records_id_fk FOREIGN KEY (record_id) REFERENCES registry_records(id) ON DELETE RESTRICT,
 CONSTRAINT registry_inquiry_results_conflicts_with_id_registry_records_id_fk FOREIGN KEY (conflicts_with_id) REFERENCES registry_records(id) ON DELETE RESTRICT
);
--> statement-breakpoint
-- Hand-written integrity, audit and access rules.
CREATE FUNCTION af_0006_record_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_user = 'af_control' AND (NEW.source IN ('orchestrator','agent_proposal') AND (NEW.status = 'draft' OR (NEW.source = 'orchestrator' AND NEW.kind = 'precedent'))) IS NOT TRUE THEN RAISE EXCEPTION 'control may insert precedents and drafts only'; END IF;
 IF NEW.kind IN ('fact','precedent') AND NEW.evidence IS NULL THEN RAISE EXCEPTION 'evidence required'; END IF;
 IF NEW.status IS NOT NULL AND NEW.status NOT IN ('draft','active') THEN RAISE EXCEPTION 'record must start as draft or active'; END IF;
 IF NEW.status = 'active' AND (NEW.scope_type = 'project' AND ((NEW.source = 'poll_press' AND NEW.kind = 'decision') OR (NEW.source = 'orchestrator' AND NEW.kind = 'precedent'))) IS NOT TRUE THEN RAISE EXCEPTION 'invalid active record'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER registry_records_insert BEFORE INSERT ON registry_records FOR EACH ROW EXECUTE FUNCTION af_0006_record_insert();
-- Clauses accept a record UUID directly or an object carrying its record_id (or id).
CREATE FUNCTION af_0006_clause_ids(clauses jsonb) RETURNS SETOF uuid LANGUAGE sql IMMUTABLE AS $$
 SELECT COALESCE(item->>'record_id', item->>'id', item #>> '{}')::uuid
 FROM jsonb_array_elements(clauses) AS item
$$;
CREATE FUNCTION af_0006_regulation_rules() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE max_bytes integer; previous_id uuid; previous_clauses jsonb;
BEGIN
 IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
 IF NEW.status = 'active' THEN
  SELECT (value #>> '{}')::integer INTO max_bytes FROM public.settings WHERE key = 'registry.clauseMaxBytes';
  IF max_bytes IS NOT NULL AND NEW.clauses_bytes > max_bytes THEN RAISE EXCEPTION 'regulation clauses exceed registry.clauseMaxBytes'; END IF;
  IF EXISTS (SELECT 1 FROM public.af_0006_clause_ids(NEW.clauses) c(id) LEFT JOIN public.registry_records r ON r.id = c.id WHERE r.id IS NULL OR r.kind IS DISTINCT FROM 'rule' OR (r.status IN ('draft','active')) IS NOT TRUE OR (r.scope_type IN ('global','project')) IS NOT TRUE) THEN RAISE EXCEPTION 'regulation clause requires a rule in scope'; END IF;
  SELECT id, clauses INTO previous_id, previous_clauses FROM public.regulation_versions WHERE status = 'active' AND id <> NEW.id FOR UPDATE;
  IF previous_id IS NOT NULL THEN
   UPDATE public.regulation_versions SET status = 'superseded', status_changed_at = NEW.status_changed_at WHERE id = previous_id;
   UPDATE public.registry_records SET status = 'superseded', status_changed_at = NEW.status_changed_at, status_changed_by = jsonb_build_object('id',NEW.confirmed_by)
    WHERE id IN (SELECT public.af_0006_clause_ids(previous_clauses) EXCEPT SELECT public.af_0006_clause_ids(NEW.clauses)) AND status = 'active';
  END IF;
  UPDATE public.registry_records SET status = 'active', status_changed_at = NEW.status_changed_at, status_changed_by = jsonb_build_object('id',NEW.confirmed_by)
   WHERE id IN (SELECT public.af_0006_clause_ids(NEW.clauses)) AND status = 'draft';
 ELSIF NEW.status = 'revoked' AND OLD.status = 'active' THEN
  UPDATE public.registry_records SET status = 'revoked', status_changed_at = NEW.status_changed_at, status_changed_by = jsonb_build_object('id',NEW.confirmed_by)
   WHERE id IN (SELECT public.af_0006_clause_ids(OLD.clauses)) AND status = 'active';
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION af_0006_regulation_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status = 'active' THEN RAISE EXCEPTION 'regulation must be activated from a draft'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER regulation_versions_insert BEFORE INSERT ON regulation_versions FOR EACH ROW EXECUTE FUNCTION af_0006_regulation_insert();
CREATE TRIGGER regulation_versions_rules BEFORE UPDATE ON regulation_versions FOR EACH ROW EXECUTE FUNCTION af_0006_regulation_rules();
CREATE TRIGGER registry_links_immutable BEFORE UPDATE OR DELETE ON registry_links FOR EACH ROW EXECUTE FUNCTION af_refuse_immutable_change();
CREATE TRIGGER registry_embeddings_immutable BEFORE UPDATE OR DELETE ON registry_embeddings FOR EACH ROW EXECUTE FUNCTION af_refuse_immutable_change();
CREATE TRIGGER registry_inquiries_content BEFORE UPDATE OR DELETE ON registry_inquiries FOR EACH ROW EXECUTE FUNCTION af_0003_guard_content('{poll_question,poll_options,poll_registered_at}', '{poll_question,poll_options,poll_registered_at}');
CREATE TRIGGER registry_results_content BEFORE UPDATE OR DELETE ON registry_inquiry_results FOR EACH ROW EXECUTE FUNCTION af_0003_guard_content('{verdict,difference,conflicts_with_id,verdict_at}', '{verdict,difference,conflicts_with_id,verdict_at}');
-- Stored generated columns are not populated in NEW until after BEFORE triggers.
-- Only status, status_changed_at and status_changed_by may change.
CREATE FUNCTION af_0006_record_content() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'registry_records is immutable'; END IF;
 IF (to_jsonb(NEW) - ARRAY['status','status_changed_at','status_changed_by','search_ru','search_en']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','status_changed_at','status_changed_by','search_ru','search_en']) THEN RAISE EXCEPTION 'registry_records content is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER registry_records_content BEFORE UPDATE OR DELETE ON registry_records FOR EACH ROW EXECUTE FUNCTION af_0006_record_content();
CREATE TRIGGER regulation_versions_content BEFORE UPDATE OR DELETE ON regulation_versions FOR EACH ROW EXECUTE FUNCTION af_0003_guard_content('{status,status_changed_at,conflict_report,confirmed_by,confirmation_id,activated_at}', '{conflict_report,confirmed_by,confirmation_id,activated_at}');
CREATE FUNCTION af_0006_status_audit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid; details jsonb;
BEGIN
 IF NEW.status IS DISTINCT FROM OLD.status OR (TG_TABLE_NAME = 'regulation_versions' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) OR (TG_TABLE_NAME = 'registry_records' AND (to_jsonb(NEW)->'status_changed_at', to_jsonb(NEW)->'status_changed_by') IS DISTINCT FROM (to_jsonb(OLD)->'status_changed_at', to_jsonb(OLD)->'status_changed_by')) THEN
  IF TG_TABLE_NAME = 'registry_records' AND NEW.status IS DISTINCT FROM OLD.status AND (((OLD.status = 'draft' AND NEW.status IN ('active','rejected')) OR (OLD.status = 'active' AND NEW.status IN ('superseded','revoked'))) IS NOT TRUE) THEN RAISE EXCEPTION 'invalid registry status change'; END IF;
  IF TG_TABLE_NAME = 'registry_records' THEN
  IF NEW.kind = 'rule' AND (NEW.status = 'active' OR OLD.status = 'active') AND NEW.status IS DISTINCT FROM OLD.status AND pg_trigger_depth() < 2 THEN RAISE EXCEPTION 'rule status requires regulation change'; END IF;
 END IF;
  IF TG_TABLE_NAME = 'registry_records' THEN
   actor := NULLIF(NEW.status_changed_by->>'id','')::uuid;
   details := jsonb_build_object('old_status',OLD.status,'new_status',NEW.status,'press_id',NEW.press_id,'actor',NEW.status_changed_by);
  ELSE
   actor := NEW.confirmed_by;
   details := jsonb_build_object('old_status',OLD.status,'new_status',NEW.status,'confirmation_id',NEW.confirmation_id);
  END IF;
  INSERT INTO public.audit_log(id,actor_id,action,target_type,target_id,outcome,details) VALUES (gen_random_uuid(),actor,CASE WHEN TG_TABLE_NAME = 'registry_records' THEN 'registry.status' ELSE 'regulation.status' END,TG_TABLE_NAME,NEW.id,'ok',details);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER registry_records_status BEFORE UPDATE ON registry_records FOR EACH ROW EXECUTE FUNCTION af_0006_status_audit();
CREATE TRIGGER regulation_versions_status BEFORE UPDATE ON regulation_versions FOR EACH ROW EXECUTE FUNCTION af_0006_status_audit();
-- database.md: af_api has select and insert on all six registry tables; af_control only inserts precedents and drafts
-- (the af_0006_record_insert check on source), so it gets select on all six (database.md "As af_api"), insert on registry_records and no update.
GRANT SELECT, INSERT ON regulation_versions, registry_inquiries, registry_records, registry_links, registry_embeddings, registry_inquiry_results TO af_api;
GRANT SELECT, INSERT ON registry_records TO af_control;
GRANT SELECT ON regulation_versions, registry_inquiries, registry_links, registry_embeddings, registry_inquiry_results TO af_control;
GRANT UPDATE (status,status_changed_at,conflict_report,confirmed_by,confirmation_id,activated_at) ON regulation_versions TO af_api;
GRANT UPDATE (status,status_changed_at,status_changed_by) ON registry_records TO af_api;
GRANT UPDATE (poll_question,poll_options,poll_registered_at) ON registry_inquiries TO af_api;
GRANT UPDATE (verdict,difference,conflicts_with_id,verdict_at) ON registry_inquiry_results TO af_api;
GRANT SELECT ON regulation_versions, registry_inquiries, registry_records, registry_links, registry_embeddings, registry_inquiry_results TO af_backup;
GRANT USAGE, SELECT ON SEQUENCE registry_inquiries_number_seq, registry_records_number_seq TO af_api;
GRANT USAGE, SELECT ON SEQUENCE registry_records_number_seq TO af_control;
GRANT SELECT ON SEQUENCE registry_inquiries_number_seq, registry_records_number_seq TO af_backup;

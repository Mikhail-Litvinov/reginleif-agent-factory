CREATE TABLE "devices" (
 "id" uuid PRIMARY KEY NOT NULL, "owner_id" uuid, "name" text, "platform" text, "code_hash" text,
 "code_expires_at" timestamp with time zone, "code_used_at" timestamp with time zone,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL, "revoked_at" timestamp with time zone,
 "updated_at" timestamp with time zone DEFAULT now() NOT NULL, "row_version" bigint DEFAULT 1 NOT NULL,
 CONSTRAINT "devices_platform" CHECK ("platform" IN ('android','windows'))
);
--> statement-breakpoint
CREATE TABLE "device_sessions" (
 "id" uuid PRIMARY KEY NOT NULL, "device_id" uuid, "prefix" text, "token_hash" text,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL, "expires_at" timestamp with time zone,
 "last_used_at" timestamp with time zone, "revoked_at" timestamp with time zone,
 "updated_at" timestamp with time zone DEFAULT now() NOT NULL, "row_version" bigint DEFAULT 1 NOT NULL,
 CONSTRAINT "device_sessions_prefix_unique" UNIQUE ("prefix")
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
 "id" uuid PRIMARY KEY NOT NULL, "seq" bigint GENERATED ALWAYS AS IDENTITY, "kind" text, "task_id" uuid,
 "payload" jsonb, "state" text, "attempts" integer, "next_attempt_at" timestamp with time zone, "lease_owner" text,
 "lease_until" timestamp with time zone, "last_error" text, "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 "done_at" timestamp with time zone, "updated_at" timestamp with time zone DEFAULT now() NOT NULL, "row_version" bigint DEFAULT 1 NOT NULL,
 CONSTRAINT "outbox_kind" CHECK ("kind" IN ('start_workflow','deliver_decision','wake','notify','cleanup')),
 CONSTRAINT "outbox_state" CHECK ("state" IN ('pending','sent','done','failed'))
);
--> statement-breakpoint
CREATE TABLE "confirmations" (
 "id" uuid PRIMARY KEY NOT NULL, "actor_id" uuid, "channel" text, "device_session_id" uuid, "operation" text,
 "target_type" text, "target_id" uuid, "request_hash" text, "nonce_hash" text,
 "issued_at" timestamp with time zone DEFAULT now() NOT NULL, "expires_at" timestamp with time zone,
 "used_at" timestamp with time zone, "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
 "row_version" bigint DEFAULT 1 NOT NULL, CONSTRAINT "confirmations_channel" CHECK ("channel" IN ('client','telegram','api'))
);
--> statement-breakpoint
CREATE TABLE "task_decisions" (
 -- 0004 adds the engineer_run_id foreign key when task_runs exists.
 "id" uuid PRIMARY KEY NOT NULL, "task_id" uuid, "kind" text, "actor_id" uuid, "engineer_run_id" uuid, "channel" text,
 "device_session_id" uuid, "press_id" text, "revision_number" integer, "payload" jsonb, "confirmation_id" uuid,
 "idempotency_key" text, "request_hash" text, "delivery_state" text, "refusal_reason" text, "outbox_id" uuid,
 "recorded_at" timestamp with time zone DEFAULT now() NOT NULL, "delivered_at" timestamp with time zone,
 "resolved_at" timestamp with time zone, "updated_at" timestamp with time zone DEFAULT now() NOT NULL, "row_version" bigint DEFAULT 1 NOT NULL,
 CONSTRAINT "task_decisions_actor_key" UNIQUE ("actor_id","idempotency_key"), CONSTRAINT "task_decisions_engineer_key" UNIQUE ("engineer_run_id","idempotency_key"),
 CONSTRAINT "task_decisions_kind" CHECK ("kind" IN ('approve','reject','request_changes','cancel','pause','resume','revise_requirements','add_feedback','change_priority','resolve_block','force_close','allow_agent','physical_decision')),
 CONSTRAINT "task_decisions_channel" CHECK ("channel" IN ('client','telegram','api')),
 CONSTRAINT "task_decisions_state" CHECK ("delivery_state" IN ('recorded','delivering','applied','refused')),
 CONSTRAINT "task_decisions_actor" CHECK (("actor_id" IS NOT NULL) <> ("engineer_run_id" IS NOT NULL)),
 CONSTRAINT "task_decisions_physical" CHECK (("kind" = 'physical_decision' AND "actor_id" IS NULL AND "outbox_id" IS NULL AND "delivery_state" IS NOT DISTINCT FROM 'applied') OR ("kind" IS DISTINCT FROM 'physical_decision' AND "outbox_id" IS NOT NULL)),
 CONSTRAINT "task_decisions_revision" CHECK ("kind" NOT IN ('approve','reject','request_changes','resolve_block','revise_requirements') OR "revision_number" IS NOT NULL),
 CONSTRAINT "task_decisions_refusal" CHECK ("delivery_state" <> 'refused' OR "refusal_reason" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
 "actor_id" uuid NOT NULL, "key" text NOT NULL, "request_hash" text, "response_status" integer, "response_body" jsonb,
 "state" text, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
 "row_version" bigint DEFAULT 1 NOT NULL, CONSTRAINT "idempotency_keys_actor_id_key_pk" PRIMARY KEY ("actor_id","key"),
 CONSTRAINT "idempotency_keys_state" CHECK ("state" IN ('in_progress','done'))
);
--> statement-breakpoint
CREATE TABLE "task_revisions" (
 "id" uuid PRIMARY KEY NOT NULL, "task_id" uuid, "revision_number" integer, "requirements" text, "acceptance_criteria" jsonb,
 "constraints" jsonb, "change_reason" text NOT NULL, "author_id" uuid, "decision_id" uuid, "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 CONSTRAINT "task_revisions_task_number" UNIQUE ("task_id","revision_number"),
 CONSTRAINT "task_revisions_acceptance" CHECK (jsonb_typeof("acceptance_criteria") = 'array')
);
--> statement-breakpoint
CREATE TABLE "notifications" (
 "id" uuid PRIMARY KEY NOT NULL, "seq" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
 "commit_xid" "xid8" DEFAULT pg_current_xact_id() NOT NULL, "event_type" text, "dedup_key" text, "task_id" uuid, "worker_id" uuid,
 "state" text, "occurrences" integer, "first_raised_at" timestamp with time zone, "last_raised_at" timestamp with time zone,
 "delivered_at" timestamp with time zone, "resolved_at" timestamp with time zone,
 "updated_at" timestamp with time zone DEFAULT now() NOT NULL, "row_version" bigint DEFAULT 1 NOT NULL,
 CONSTRAINT "notifications_seq_unique" UNIQUE ("seq"), CONSTRAINT "notifications_state" CHECK ("state" IN ('open','resolved')),
 CONSTRAINT "notifications_event_type" CHECK ("event_type" IN ('worker_offline','workflow_failed','task_blocked','approval_required','infrastructure_unavailable','backup_failed','retry_limit_exceeded','budget_exceeded','no_machine_available','no_eligible_agent','usage_limit_wait','cancel_unconfirmed','cleanup_stuck','decision_refused'))
);
--> statement-breakpoint
CREATE TABLE "conversations" (
 "id" uuid PRIMARY KEY NOT NULL, "source" text, "session_ref" text, "project_id" uuid, "task_id" uuid, "state" text, "title" text,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL, "last_message_at" timestamp with time zone, "archived_at" timestamp with time zone,
 "updated_at" timestamp with time zone DEFAULT now() NOT NULL, "row_version" bigint DEFAULT 1 NOT NULL,
 CONSTRAINT "conversations_source" CHECK ("source" IN ('rig_session','factory')),
 CONSTRAINT "conversations_state" CHECK ("state" IN ('active','waiting','permission_wait','ended'))
);
--> statement-breakpoint
CREATE TABLE "messages" (
 "id" uuid PRIMARY KEY NOT NULL, "seq" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
 "commit_xid" "xid8" DEFAULT pg_current_xact_id() NOT NULL, "conversation_id" uuid, "source_key" text, "kind" text,
 "author" text, "body" text, "parsed" jsonb, "task_id" uuid, "attachment_ids" uuid[], "device_session_id" uuid,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 CONSTRAINT "messages_conversation_source" UNIQUE ("conversation_id","source_key"),
 CONSTRAINT "messages_kind" CHECK ("kind" IN ('text','result','question','approval','blocker','status','owner')),
 CONSTRAINT "messages_author" CHECK ("author" IN ('agent','owner','system')),
 CONSTRAINT "messages_owner_session" CHECK ("author" <> 'owner' OR "device_session_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "polls" (
 "id" uuid PRIMARY KEY NOT NULL, "conversation_id" uuid, "message_id" uuid, "source_key" text, "options" jsonb,
 "task_id" uuid, "revision_number" integer, "decision_id" uuid, "arbiter" text NOT NULL, "state" text, "answer_key" text,
 "answered_via" text, "answered_session_id" uuid, "answered_at" timestamp with time zone,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
 "row_version" bigint DEFAULT 1 NOT NULL, CONSTRAINT "polls_conversation_source" UNIQUE ("conversation_id","source_key"),
 CONSTRAINT "polls_arbiter" CHECK ("arbiter" IN ('hub','api')),
 CONSTRAINT "polls_task_arbiter" CHECK (("task_id" IS NOT NULL) = ("arbiter" = 'api')),
 CONSTRAINT "polls_decision_arbiter" CHECK ("decision_id" IS NULL OR "arbiter" = 'api'),
 CONSTRAINT "polls_state" CHECK ("state" IN ('open','answered','expired')),
 CONSTRAINT "polls_answered_via" CHECK ("answered_via" IN ('client','telegram','api')),
 CONSTRAINT "polls_options" CHECK (jsonb_typeof("options") = 'array')
);
--> statement-breakpoint
CREATE TABLE "poll_answer_requests" (
 "id" uuid PRIMARY KEY NOT NULL, "poll_id" uuid, "device_session_id" uuid, "idempotency_key" text, "answer_key" text,
 "state" text, "refusal_reason" text, "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 "delivered_at" timestamp with time zone, "decided_at" timestamp with time zone, "hub_ref" text,
 "updated_at" timestamp with time zone DEFAULT now() NOT NULL, "row_version" bigint DEFAULT 1 NOT NULL,
 CONSTRAINT "poll_answer_requests_state" CHECK ("state" IN ('pending','accepted','refused')),
 CONSTRAINT "poll_answer_requests_refusal" CHECK ("state" <> 'refused' OR "refusal_reason" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "owners"("id") ON DELETE restrict;
ALTER TABLE "device_sessions" ADD CONSTRAINT "device_sessions_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE restrict;
ALTER TABLE "confirmations" ADD CONSTRAINT "confirmations_actor_id_owners_id_fk" FOREIGN KEY ("actor_id") REFERENCES "owners"("id") ON DELETE restrict;
ALTER TABLE "confirmations" ADD CONSTRAINT "confirmations_device_session_id_device_sessions_id_fk" FOREIGN KEY ("device_session_id") REFERENCES "device_sessions"("id") ON DELETE restrict;
ALTER TABLE "task_decisions" ADD CONSTRAINT "task_decisions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE restrict;
ALTER TABLE "task_decisions" ADD CONSTRAINT "task_decisions_actor_id_owners_id_fk" FOREIGN KEY ("actor_id") REFERENCES "owners"("id") ON DELETE restrict;
ALTER TABLE "task_decisions" ADD CONSTRAINT "task_decisions_device_session_id_device_sessions_id_fk" FOREIGN KEY ("device_session_id") REFERENCES "device_sessions"("id") ON DELETE restrict;
ALTER TABLE "task_decisions" ADD CONSTRAINT "task_decisions_confirmation_id_confirmations_id_fk" FOREIGN KEY ("confirmation_id") REFERENCES "confirmations"("id") ON DELETE restrict;
ALTER TABLE "task_decisions" ADD CONSTRAINT "task_decisions_outbox_id_outbox_events_id_fk" FOREIGN KEY ("outbox_id") REFERENCES "outbox_events"("id") ON DELETE restrict DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "outbox_events" ADD COLUMN "decision_id" uuid;
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_decision_id_task_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "task_decisions"("id") ON DELETE restrict DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "confirmations" ADD COLUMN "decision_id" uuid;
ALTER TABLE "confirmations" ADD CONSTRAINT "confirmations_decision_id_task_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "task_decisions"("id") ON DELETE restrict;
ALTER TABLE "task_revisions" ADD CONSTRAINT "task_revisions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE restrict;
ALTER TABLE "task_revisions" ADD CONSTRAINT "task_revisions_decision_id_task_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "task_decisions"("id") ON DELETE restrict;
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE restrict;
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE restrict;
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE restrict;
ALTER TABLE "messages" ADD CONSTRAINT "messages_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE restrict;
ALTER TABLE "messages" ADD CONSTRAINT "messages_device_session_id_device_sessions_id_fk" FOREIGN KEY ("device_session_id") REFERENCES "device_sessions"("id") ON DELETE restrict;
ALTER TABLE "polls" ADD CONSTRAINT "polls_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE restrict;
ALTER TABLE "polls" ADD CONSTRAINT "polls_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE restrict;
ALTER TABLE "polls" ADD CONSTRAINT "polls_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE restrict;
ALTER TABLE "polls" ADD CONSTRAINT "polls_decision_id_task_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "task_decisions"("id") ON DELETE restrict;
ALTER TABLE "polls" ADD CONSTRAINT "polls_answered_session_id_device_sessions_id_fk" FOREIGN KEY ("answered_session_id") REFERENCES "device_sessions"("id") ON DELETE restrict;
ALTER TABLE "poll_answer_requests" ADD CONSTRAINT "poll_answer_requests_poll_id_polls_id_fk" FOREIGN KEY ("poll_id") REFERENCES "polls"("id") ON DELETE restrict;
ALTER TABLE "poll_answer_requests" ADD CONSTRAINT "poll_answer_requests_device_session_id_device_sessions_id_fk" FOREIGN KEY ("device_session_id") REFERENCES "device_sessions"("id") ON DELETE restrict;
ALTER TABLE "audit_log" ADD COLUMN "device_session_id" uuid;
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_device_session_id_device_sessions_id_fk" FOREIGN KEY ("device_session_id") REFERENCES "device_sessions"("id") ON DELETE restrict;
ALTER TABLE "api_tokens" DROP CONSTRAINT "api_tokens_role";
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_role" CHECK ("role" IN ('owner','worker','relay','reader','hub'));
--> statement-breakpoint
CREATE INDEX "device_sessions_live_device" ON "device_sessions" ("device_id") WHERE "revoked_at" IS NULL;
CREATE UNIQUE INDEX "outbox_start_workflow" ON "outbox_events" ("kind","task_id") WHERE "kind" = 'start_workflow';
CREATE INDEX "outbox_pending" ON "outbox_events" ("next_attempt_at") WHERE "state" IN ('pending','sent');
CREATE UNIQUE INDEX "task_decisions_press" ON "task_decisions" ("press_id") WHERE "press_id" IS NOT NULL;
CREATE UNIQUE INDEX "notifications_open_dedup" ON "notifications" ("dedup_key") WHERE "state" = 'open';
CREATE INDEX "notifications_cursor" ON "notifications" ("commit_xid","seq");
CREATE UNIQUE INDEX "conversations_source_session" ON "conversations" ("source","session_ref") WHERE "session_ref" IS NOT NULL;
CREATE INDEX "messages_cursor" ON "messages" ("commit_xid","seq");
CREATE INDEX "messages_conversation_seq" ON "messages" ("conversation_id","seq");
CREATE INDEX "polls_state_created" ON "polls" ("state","created_at");
CREATE UNIQUE INDEX "poll_answer_requests_session_key" ON "poll_answer_requests" ("device_session_id","idempotency_key");
CREATE INDEX "poll_answer_requests_pending" ON "poll_answer_requests" ("created_at") WHERE "state" = 'pending';
--> statement-breakpoint
-- Hand-written guards and grants.
CREATE FUNCTION af_0003_guard_content() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allowed text[] := TG_ARGV[0]::text[]; once_fields text[] := TG_ARGV[1]::text[]; field text;
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '% is immutable', TG_TABLE_NAME; END IF;
 IF (to_jsonb(NEW) - allowed) IS DISTINCT FROM (to_jsonb(OLD) - allowed) THEN
  RAISE EXCEPTION '% content is immutable', TG_TABLE_NAME;
 END IF;
 FOREACH field IN ARRAY once_fields LOOP
  IF (to_jsonb(OLD)->field) IS DISTINCT FROM 'null'::jsonb AND (to_jsonb(NEW)->field) IS DISTINCT FROM (to_jsonb(OLD)->field) THEN
   RAISE EXCEPTION '% cannot change twice', field;
  END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER devices_content BEFORE UPDATE OR DELETE ON devices FOR EACH ROW EXECUTE FUNCTION af_0003_guard_content('{code_used_at,revoked_at,updated_at,row_version}', '{code_used_at,revoked_at}');
CREATE FUNCTION af_0003_device_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.code_used_at IS NULL AND NEW.code_used_at IS NOT NULL AND (NEW.code_expires_at IS NULL OR NEW.code_expires_at <= now() OR NEW.revoked_at IS NOT NULL) THEN
  RAISE EXCEPTION 'device code expired or revoked';
 END IF;
 IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
  UPDATE device_sessions SET revoked_at = NEW.revoked_at, updated_at = now(), row_version = row_version + 1 WHERE device_id = NEW.id AND revoked_at IS NULL;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER devices_lifecycle BEFORE UPDATE ON devices FOR EACH ROW EXECUTE FUNCTION af_0003_device_lifecycle();
CREATE FUNCTION af_0003_session_device() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE device_revoked timestamp with time zone;
BEGIN
 IF NEW.device_id IS NOT NULL THEN
  SELECT revoked_at INTO device_revoked FROM devices WHERE id = NEW.device_id FOR UPDATE;
  IF device_revoked IS NOT NULL THEN RAISE EXCEPTION 'device is revoked'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER device_sessions_device BEFORE INSERT ON device_sessions FOR EACH ROW EXECUTE FUNCTION af_0003_session_device();
CREATE TRIGGER confirmations_content BEFORE UPDATE OR DELETE ON confirmations FOR EACH ROW EXECUTE FUNCTION af_0003_guard_content('{used_at,decision_id,updated_at,row_version}', '{used_at,decision_id}');
CREATE TRIGGER task_decisions_content BEFORE UPDATE OR DELETE ON task_decisions FOR EACH ROW EXECUTE FUNCTION af_0003_guard_content('{delivery_state,refusal_reason,delivered_at,resolved_at,updated_at,row_version}', '{}');
CREATE TRIGGER polls_content BEFORE UPDATE OR DELETE ON polls FOR EACH ROW EXECUTE FUNCTION af_0003_guard_content('{state,answer_key,answered_via,answered_session_id,answered_at,decision_id,updated_at,row_version}', '{answer_key,answered_via,answered_session_id,answered_at,decision_id}');
CREATE TRIGGER poll_answer_requests_content BEFORE UPDATE OR DELETE ON poll_answer_requests FOR EACH ROW EXECUTE FUNCTION af_0003_guard_content('{state,refusal_reason,delivered_at,decided_at,hub_ref,updated_at,row_version}', '{refusal_reason,delivered_at,decided_at,hub_ref}');
CREATE FUNCTION af_0003_guard_poll_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state IS DISTINCT FROM NEW.state AND OLD.state IS NOT NULL AND OLD.state NOT IN ('open','pending') THEN
  RAISE EXCEPTION 'poll result is immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER polls_state_once BEFORE UPDATE ON polls FOR EACH ROW EXECUTE FUNCTION af_0003_guard_poll_state();
CREATE TRIGGER poll_answer_requests_state_once BEFORE UPDATE ON poll_answer_requests FOR EACH ROW EXECUTE FUNCTION af_0003_guard_poll_state();
CREATE FUNCTION af_0003_poll_request_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.state IS DISTINCT FROM 'pending' THEN RAISE EXCEPTION 'poll answer request must start pending'; END IF;
 IF NEW.poll_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM polls WHERE id = NEW.poll_id AND arbiter = 'hub') THEN
  RAISE EXCEPTION 'poll answer request requires a hub poll';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER poll_answer_requests_initial_state BEFORE INSERT ON poll_answer_requests FOR EACH ROW EXECUTE FUNCTION af_0003_poll_request_insert();
CREATE FUNCTION af_0003_engineer_decision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.engineer_run_id IS NOT NULL THEN
  IF NEW.channel IS DISTINCT FROM 'api' OR NEW.kind IS NULL OR NEW.kind NOT IN ('resolve_block','physical_decision') THEN
   RAISE EXCEPTION 'invalid engineer decision';
  END IF;
  IF NEW.kind = 'resolve_block' AND NOT EXISTS (SELECT 1 FROM tasks WHERE id = NEW.task_id AND block_handler = 'chief_engineer') THEN
   RAISE EXCEPTION 'engineer decision requires chief engineer block';
  END IF;
  -- The robotics migration adds the physical platform/task relationship check.
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER task_decisions_engineer_guard BEFORE INSERT ON task_decisions FOR EACH ROW EXECUTE FUNCTION af_0003_engineer_decision();
CREATE TRIGGER task_revisions_immutable BEFORE UPDATE OR DELETE ON task_revisions FOR EACH ROW EXECUTE FUNCTION af_refuse_immutable_change();
CREATE TRIGGER messages_immutable BEFORE UPDATE OR DELETE ON messages FOR EACH ROW EXECUTE FUNCTION af_refuse_immutable_change();
CREATE TRIGGER device_sessions_no_delete BEFORE DELETE ON device_sessions FOR EACH ROW EXECUTE FUNCTION af_refuse_delete();
CREATE TRIGGER outbox_events_no_delete BEFORE DELETE ON outbox_events FOR EACH ROW EXECUTE FUNCTION af_refuse_delete();
CREATE TRIGGER idempotency_keys_no_delete BEFORE DELETE ON idempotency_keys FOR EACH ROW EXECUTE FUNCTION af_refuse_delete();
CREATE TRIGGER notifications_no_delete BEFORE DELETE ON notifications FOR EACH ROW EXECUTE FUNCTION af_refuse_delete();
CREATE TRIGGER conversations_no_delete BEFORE DELETE ON conversations FOR EACH ROW EXECUTE FUNCTION af_refuse_delete();
CREATE FUNCTION af_0003_revision_sequence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE next_number integer;
BEGIN
 IF NEW.task_id IS NOT NULL AND NEW.revision_number IS NOT NULL THEN
  PERFORM 1 FROM tasks WHERE id = NEW.task_id FOR UPDATE;
  SELECT COALESCE(max(revision_number), 0) + 1 INTO next_number FROM task_revisions WHERE task_id = NEW.task_id;
  IF NEW.revision_number <> next_number THEN RAISE EXCEPTION 'revision number must be contiguous'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER task_revisions_sequence BEFORE INSERT ON task_revisions FOR EACH ROW EXECUTE FUNCTION af_0003_revision_sequence();
CREATE FUNCTION af_0003_pair_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME = 'task_decisions' THEN
  IF EXISTS (SELECT 1 FROM task_decisions d WHERE d.id = NEW.id AND d.outbox_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM outbox_events o WHERE o.id = d.outbox_id AND o.decision_id = d.id)) THEN RAISE EXCEPTION 'outbox decision pair does not match'; END IF;
 ELSE
  IF EXISTS (SELECT 1 FROM outbox_events o WHERE o.id = NEW.id AND o.decision_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM task_decisions d WHERE d.id = o.decision_id AND d.outbox_id = o.id)) THEN RAISE EXCEPTION 'outbox decision pair does not match'; END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER outbox_decision_pair AFTER INSERT OR UPDATE ON outbox_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION af_0003_pair_guard();
CREATE CONSTRAINT TRIGGER decision_outbox_pair AFTER INSERT OR UPDATE ON task_decisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION af_0003_pair_guard();
GRANT SELECT, INSERT ON outbox_events, confirmations, task_decisions, idempotency_keys, task_revisions, notifications TO af_api, af_control;
GRANT UPDATE (state, attempts, next_attempt_at, lease_owner, lease_until, last_error, done_at, updated_at, row_version) ON outbox_events TO af_control;
GRANT UPDATE (used_at, decision_id, updated_at, row_version) ON confirmations TO af_api, af_control;
GRANT UPDATE (delivery_state, refusal_reason, delivered_at, resolved_at, updated_at, row_version) ON task_decisions TO af_control;
GRANT UPDATE (response_status, response_body, state, updated_at, row_version) ON idempotency_keys TO af_api, af_control;
GRANT UPDATE (state, occurrences, last_raised_at, delivered_at, resolved_at, updated_at, row_version) ON notifications TO af_api, af_control;
GRANT SELECT, INSERT ON devices, device_sessions, conversations, messages, polls, poll_answer_requests TO af_api;
GRANT SELECT ON devices, device_sessions, conversations, messages, polls, poll_answer_requests TO af_control;
GRANT UPDATE (code_used_at, revoked_at, updated_at, row_version) ON devices TO af_api;
GRANT UPDATE (last_used_at, revoked_at, updated_at, row_version) ON device_sessions TO af_api;
GRANT UPDATE (last_message_at, archived_at, state, updated_at, row_version) ON conversations TO af_api;
GRANT UPDATE (state, answer_key, answered_via, answered_session_id, answered_at, decision_id, updated_at, row_version) ON polls TO af_api;
GRANT UPDATE (state, refusal_reason, delivered_at, decided_at, hub_ref, updated_at, row_version) ON poll_answer_requests TO af_api;
GRANT SELECT ON devices, device_sessions, outbox_events, confirmations, task_decisions, idempotency_keys, task_revisions, notifications, conversations, messages, polls, poll_answer_requests TO af_backup;
GRANT USAGE, SELECT ON SEQUENCE outbox_events_seq_seq, notifications_seq_seq TO af_api, af_control;
GRANT USAGE, SELECT ON SEQUENCE messages_seq_seq TO af_api;
GRANT SELECT ON SEQUENCE outbox_events_seq_seq, notifications_seq_seq, messages_seq_seq TO af_backup;

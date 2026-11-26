CREATE TABLE "task_reviews" (
 "id" uuid PRIMARY KEY NOT NULL, "task_id" uuid CONSTRAINT "task_reviews_task_id_tasks_id_fk" REFERENCES "tasks"("id") ON DELETE RESTRICT, "run_id" uuid CONSTRAINT "task_reviews_run_id_task_runs_id_fk" REFERENCES "task_runs"("id") ON DELETE RESTRICT,
 "reviewer_id" uuid CONSTRAINT "task_reviews_reviewer_id_agents_id_fk" REFERENCES "agents"("id") ON DELETE RESTRICT, "round" integer, "disputes_review_id" uuid CONSTRAINT "task_reviews_disputes_review_id_task_reviews_id_fk" REFERENCES "task_reviews"("id") ON DELETE RESTRICT,
 "verdict" text, "findings" jsonb, "created_at" timestamptz DEFAULT now() NOT NULL, CONSTRAINT "task_reviews_verdict" CHECK ("verdict" IN ('pass','fail','inconclusive'))
);
--> statement-breakpoint
CREATE TABLE "review_finding_outcomes" (
 "id" uuid PRIMARY KEY NOT NULL, "review_id" uuid CONSTRAINT "review_finding_outcomes_review_id_task_reviews_id_fk" REFERENCES "task_reviews"("id") ON DELETE RESTRICT, "finding_key" text, "outcome" text,
 "run_id" uuid CONSTRAINT "review_finding_outcomes_run_id_task_runs_id_fk" REFERENCES "task_runs"("id") ON DELETE RESTRICT, "reason" text, "created_at" timestamptz DEFAULT now() NOT NULL,
 CONSTRAINT "review_finding_outcomes_outcome" CHECK ("outcome" IN ('accepted','disputed','confirmed','dismissed','owner'))
);
--> statement-breakpoint
CREATE TABLE "task_approvals" (
 "id" uuid PRIMARY KEY NOT NULL, "task_id" uuid CONSTRAINT "task_approvals_task_id_tasks_id_fk" REFERENCES "tasks"("id") ON DELETE RESTRICT, "revision_number" integer, "approval_type" text, "decision" text,
 "decision_id" uuid CONSTRAINT "task_approvals_decision_id_task_decisions_id_fk" REFERENCES "task_decisions"("id") ON DELETE RESTRICT, "policy_id" uuid CONSTRAINT "task_approvals_policy_id_execution_policies_id_fk" REFERENCES "execution_policies"("id") ON DELETE RESTRICT,
 "actor_id" uuid CONSTRAINT "task_approvals_actor_id_owners_id_fk" REFERENCES "owners"("id") ON DELETE RESTRICT, "created_at" timestamptz DEFAULT now() NOT NULL,
 CONSTRAINT "task_approvals_task_decision" UNIQUE ("task_id","decision_id"), CONSTRAINT "task_approvals_type" CHECK ("approval_type" IN ('manual','policy_auto')),
 CONSTRAINT "task_approvals_decision" CHECK ("decision" IN ('accept','reject','request_changes')),
 CONSTRAINT "task_approvals_manual" CHECK (("approval_type" = 'manual') = ("decision_id" IS NOT NULL)),
 CONSTRAINT "task_approvals_policy" CHECK ("approval_type" <> 'policy_auto' OR "policy_id" IS NOT NULL), CONSTRAINT "task_approvals_actor" CHECK ("approval_type" <> 'manual' OR "actor_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "task_proposals" (
 "id" uuid PRIMARY KEY NOT NULL, "task_id" uuid CONSTRAINT "task_proposals_task_id_tasks_id_fk" REFERENCES "tasks"("id") ON DELETE RESTRICT, "run_id" uuid CONSTRAINT "task_proposals_run_id_task_runs_id_fk" REFERENCES "task_runs"("id") ON DELETE RESTRICT,
 "kind" text, "title" text, "requirements" text, "covers" jsonb, "state" text, "child_task_id" uuid CONSTRAINT "task_proposals_child_task_id_tasks_id_fk" REFERENCES "tasks"("id") ON DELETE RESTRICT,
 "decided_by" uuid CONSTRAINT "task_proposals_decided_by_owners_id_fk" REFERENCES "owners"("id") ON DELETE RESTRICT, "created_at" timestamptz DEFAULT now() NOT NULL, "decided_at" timestamptz,
 "updated_at" timestamptz DEFAULT now() NOT NULL, "row_version" bigint DEFAULT 1 NOT NULL,
 CONSTRAINT "task_proposals_kind" CHECK ("kind" IN ('decomposition','requirement_change','suggestion')), CONSTRAINT "task_proposals_state" CHECK ("state" IN ('auto_created','open','accepted','declined'))
);
--> statement-breakpoint
-- Hand-written integrity and access rules.
CREATE FUNCTION af_0005_review_independence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM task_runs r WHERE r.id = NEW.run_id AND r.task_id = NEW.task_id AND r.role = 'reviewer' AND r.agent_id = NEW.reviewer_id) THEN
  RAISE EXCEPTION 'review requires reviewer run of task and author';
 END IF;
 IF EXISTS (SELECT 1 FROM task_runs r JOIN agents a ON a.id = r.agent_id JOIN agents reviewer ON reviewer.id = NEW.reviewer_id
            WHERE r.task_id = NEW.task_id AND r.role = 'implementer' AND (r.agent_id = NEW.reviewer_id OR a.provider IS NOT DISTINCT FROM reviewer.provider)) THEN
  RAISE EXCEPTION 'reviewer must be independent of implementer';
 END IF;
 IF NEW.disputes_review_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM task_reviews prior WHERE prior.id = NEW.disputes_review_id AND prior.task_id = NEW.task_id AND prior.run_id IS DISTINCT FROM NEW.run_id) THEN
  RAISE EXCEPTION 'settling review requires a fresh run of same task';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER task_reviews_independence BEFORE INSERT ON task_reviews FOR EACH ROW EXECUTE FUNCTION af_0005_review_independence();
CREATE TRIGGER task_reviews_immutable BEFORE UPDATE OR DELETE ON task_reviews FOR EACH ROW EXECUTE FUNCTION af_refuse_immutable_change();
CREATE TRIGGER review_finding_outcomes_immutable BEFORE UPDATE OR DELETE ON review_finding_outcomes FOR EACH ROW EXECUTE FUNCTION af_refuse_immutable_change();
CREATE TRIGGER task_approvals_immutable BEFORE UPDATE OR DELETE ON task_approvals FOR EACH ROW EXECUTE FUNCTION af_refuse_immutable_change();
CREATE TRIGGER task_proposals_content BEFORE UPDATE OR DELETE ON task_proposals FOR EACH ROW EXECUTE FUNCTION af_0003_guard_content('{state,child_task_id,decided_by,decided_at,updated_at,row_version}', '{}');
GRANT SELECT, INSERT ON task_reviews, review_finding_outcomes, task_approvals, task_proposals TO af_api, af_control;
GRANT UPDATE (state, child_task_id, decided_by, decided_at, updated_at, row_version) ON task_proposals TO af_api, af_control;
GRANT SELECT ON task_reviews, review_finding_outcomes, task_approvals, task_proposals TO af_backup;

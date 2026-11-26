import { sql } from "drizzle-orm";
import { bigint, check, integer, jsonb, pgTable, text, timestamp, unique, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import { tasks } from "./tasks.ts";
import { taskRuns } from "./runs.ts";
import { agents } from "./agents.ts";
import { owners } from "./owners.ts";
import { executionPolicies } from "./execution-policies.ts";
import { taskDecisions } from "./decisions.ts";
const time = (name: string) => timestamp(name, { withTimezone: true });
const created = () => time("created_at").notNull().defaultNow();
export const taskReviews = pgTable("task_reviews", {
	id: uuid("id").primaryKey(), taskId: uuid("task_id").references(() => tasks.id, { onDelete: "restrict" }), runId: uuid("run_id").references(() => taskRuns.id, { onDelete: "restrict" }), reviewerId: uuid("reviewer_id").references(() => agents.id, { onDelete: "restrict" }), round: integer("round"), disputesReviewId: uuid("disputes_review_id").references((): AnyPgColumn => taskReviews.id, { onDelete: "restrict" }), verdict: text("verdict"), findings: jsonb("findings"), createdAt: created(),
}, t => [check("task_reviews_verdict", sql`${t.verdict} IN ('pass','fail','inconclusive')`)]);
export const reviewFindingOutcomes = pgTable("review_finding_outcomes", {
	id: uuid("id").primaryKey(), reviewId: uuid("review_id").references(() => taskReviews.id, { onDelete: "restrict" }), findingKey: text("finding_key"), outcome: text("outcome"), runId: uuid("run_id").references(() => taskRuns.id, { onDelete: "restrict" }), reason: text("reason"), createdAt: created(),
}, t => [check("review_finding_outcomes_outcome", sql`${t.outcome} IN ('accepted','disputed','confirmed','dismissed','owner')`)]);
export const taskApprovals = pgTable("task_approvals", {
	id: uuid("id").primaryKey(), taskId: uuid("task_id").references(() => tasks.id, { onDelete: "restrict" }), revisionNumber: integer("revision_number"), approvalType: text("approval_type"), decision: text("decision"), decisionId: uuid("decision_id").references(() => taskDecisions.id, { onDelete: "restrict" }), policyId: uuid("policy_id").references(() => executionPolicies.id, { onDelete: "restrict" }), actorId: uuid("actor_id").references(() => owners.id, { onDelete: "restrict" }), createdAt: created(),
}, t => [unique("task_approvals_task_decision").on(t.taskId,t.decisionId), check("task_approvals_type", sql`${t.approvalType} IN ('manual','policy_auto')`), check("task_approvals_decision", sql`${t.decision} IN ('accept','reject','request_changes')`), check("task_approvals_manual", sql`(${t.approvalType} = 'manual') = (${t.decisionId} IS NOT NULL)`), check("task_approvals_policy", sql`${t.approvalType} <> 'policy_auto' OR ${t.policyId} IS NOT NULL`), check("task_approvals_actor", sql`${t.approvalType} <> 'manual' OR ${t.actorId} IS NOT NULL`)]);
export const taskProposals = pgTable("task_proposals", {
	id: uuid("id").primaryKey(), taskId: uuid("task_id").references(() => tasks.id, { onDelete: "restrict" }), runId: uuid("run_id").references(() => taskRuns.id, { onDelete: "restrict" }), kind: text("kind"), title: text("title"), requirements: text("requirements"), covers: jsonb("covers"), state: text("state"), childTaskId: uuid("child_task_id").references(() => tasks.id, { onDelete: "restrict" }), decidedBy: uuid("decided_by").references(() => owners.id, { onDelete: "restrict" }), createdAt: created(), decidedAt: time("decided_at"), updatedAt: time("updated_at").notNull().defaultNow(), rowVersion: bigint("row_version", { mode: "bigint" }).notNull().default(sql`1`),
}, t => [check("task_proposals_kind", sql`${t.kind} IN ('decomposition','requirement_change','suggestion')`), check("task_proposals_state", sql`${t.state} IN ('auto_created','open','accepted','declined')`)]);

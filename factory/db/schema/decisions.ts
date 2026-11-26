import { sql } from "drizzle-orm";
import { bigint, check, customType, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import { owners } from "./owners.ts";
import { tasks } from "./tasks.ts";
import { deviceSessions } from "./device-sessions.ts";
import { taskRuns } from "./runs.ts";

const xid8 = customType<{ data: string }>({ dataType: () => "xid8" });
const time = (name: string) => timestamp(name, { withTimezone: true });
const version = () => bigint("row_version", { mode: "bigint" }).notNull().default(sql`1`);
const created = () => time("created_at").notNull().defaultNow();
const updated = () => time("updated_at").notNull().defaultNow();

export const outboxEvents = pgTable("outbox_events", {
	id: uuid("id").primaryKey(), seq: bigint("seq", { mode: "bigint" }).generatedAlwaysAsIdentity().notNull(),
	kind: text("kind"), taskId: uuid("task_id"), decisionId: uuid("decision_id"),
	payload: jsonb("payload"), state: text("state"), attempts: integer("attempts"), nextAttemptAt: time("next_attempt_at"), leaseOwner: text("lease_owner"), leaseUntil: time("lease_until"), lastError: text("last_error"), createdAt: created(), doneAt: time("done_at"), updatedAt: updated(), rowVersion: version(),
}, (t) => [foreignKey({ columns: [t.decisionId], foreignColumns: [taskDecisions.id], name: "outbox_events_decision_id_task_decisions_id_fk" }).onDelete("restrict"),
	uniqueIndex("outbox_start_workflow").on(t.kind, t.taskId).where(sql`${t.kind} = 'start_workflow'`), index("outbox_pending").on(t.nextAttemptAt).where(sql`${t.state} IN ('pending','sent')`),
	check("outbox_kind", sql`${t.kind} IN ('start_workflow','deliver_decision','wake','notify','cleanup','stop_run')`), check("outbox_state", sql`${t.state} IN ('pending','sent','done','failed')`)]);

export const confirmations = pgTable("confirmations", {
	id: uuid("id").primaryKey(), actorId: uuid("actor_id").references(() => owners.id, { onDelete: "restrict" }), channel: text("channel"), deviceSessionId: uuid("device_session_id").references(() => deviceSessions.id, { onDelete: "restrict" }), operation: text("operation"), targetType: text("target_type"), targetId: uuid("target_id"), requestHash: text("request_hash"), nonceHash: text("nonce_hash"), issuedAt: time("issued_at").notNull().defaultNow(), expiresAt: time("expires_at"), usedAt: time("used_at"), decisionId: uuid("decision_id"), updatedAt: updated(), rowVersion: version(),
}, (t) => [foreignKey({ columns: [t.decisionId], foreignColumns: [taskDecisions.id], name: "confirmations_decision_id_task_decisions_id_fk" }).onDelete("restrict"), check("confirmations_channel", sql`${t.channel} IN ('client','telegram','api')`)]);

export const taskDecisions = pgTable("task_decisions", {
	id: uuid("id").primaryKey(), taskId: uuid("task_id").references(() => tasks.id, { onDelete: "restrict" }), kind: text("kind"), actorId: uuid("actor_id").references(() => owners.id, { onDelete: "restrict" }), engineerRunId: uuid("engineer_run_id").references((): AnyPgColumn => taskRuns.id, { onDelete: "restrict" }), channel: text("channel"), deviceSessionId: uuid("device_session_id").references(() => deviceSessions.id, { onDelete: "restrict" }), pressId: text("press_id"), revisionNumber: integer("revision_number"), payload: jsonb("payload"), confirmationId: uuid("confirmation_id").references((): AnyPgColumn => confirmations.id, { onDelete: "restrict" }), idempotencyKey: text("idempotency_key"), requestHash: text("request_hash"), deliveryState: text("delivery_state"), refusalReason: text("refusal_reason"), outboxId: uuid("outbox_id").references((): AnyPgColumn => outboxEvents.id, { onDelete: "restrict" }), recordedAt: time("recorded_at").notNull().defaultNow(), deliveredAt: time("delivered_at"), resolvedAt: time("resolved_at"), updatedAt: updated(), rowVersion: version(),
}, (t) => [unique("task_decisions_actor_key").on(t.actorId,t.idempotencyKey), unique("task_decisions_engineer_key").on(t.engineerRunId,t.idempotencyKey), uniqueIndex("task_decisions_press").on(t.pressId).where(sql`${t.pressId} IS NOT NULL`),
	check("task_decisions_kind", sql`${t.kind} IN ('approve','reject','request_changes','cancel','pause','resume','revise_requirements','add_feedback','change_priority','resolve_block','force_close','allow_agent','physical_decision')`), check("task_decisions_channel", sql`${t.channel} IN ('client','telegram','api')`), check("task_decisions_state", sql`${t.deliveryState} IN ('recorded','delivering','applied','refused')`), check("task_decisions_actor", sql`(${t.actorId} IS NOT NULL) <> (${t.engineerRunId} IS NOT NULL)`), check("task_decisions_physical", sql`(${t.kind} = 'physical_decision' AND ${t.actorId} IS NULL AND ${t.outboxId} IS NULL AND ${t.deliveryState} IS NOT DISTINCT FROM 'applied') OR (${t.kind} IS DISTINCT FROM 'physical_decision' AND ${t.outboxId} IS NOT NULL)`), check("task_decisions_revision", sql`${t.kind} NOT IN ('approve','reject','request_changes','resolve_block','revise_requirements') OR ${t.revisionNumber} IS NOT NULL`), check("task_decisions_refusal", sql`${t.deliveryState} <> 'refused' OR ${t.refusalReason} IS NOT NULL`)]);

export const idempotencyKeys = pgTable("idempotency_keys", {
	actorId: uuid("actor_id").notNull(), key: text("key").notNull(), requestHash: text("request_hash"), responseStatus: integer("response_status"), responseBody: jsonb("response_body"), state: text("state"), createdAt: created(), updatedAt: updated(), rowVersion: version(),
}, (t) => [primaryKey({ columns: [t.actorId,t.key] }), check("idempotency_keys_state", sql`${t.state} IN ('in_progress','done')`)]);

export const taskRevisions = pgTable("task_revisions", {
	id: uuid("id").primaryKey(), taskId: uuid("task_id").references(() => tasks.id, { onDelete: "restrict" }), revisionNumber: integer("revision_number"), requirements: text("requirements"), acceptanceCriteria: jsonb("acceptance_criteria"), constraints: jsonb("constraints"), changeReason: text("change_reason").notNull(), authorId: uuid("author_id"), decisionId: uuid("decision_id").references(() => taskDecisions.id, { onDelete: "restrict" }), createdAt: created(),
}, (t) => [unique("task_revisions_task_number").on(t.taskId,t.revisionNumber), check("task_revisions_acceptance", sql`jsonb_typeof(${t.acceptanceCriteria}) = 'array'`)]);

export const notifications = pgTable("notifications", {
	id: uuid("id").primaryKey(), seq: bigint("seq", { mode: "bigint" }).generatedAlwaysAsIdentity().notNull().unique(), commitXid: xid8("commit_xid").notNull().default(sql`pg_current_xact_id()`), eventType: text("event_type"), dedupKey: text("dedup_key"), taskId: uuid("task_id"), workerId: uuid("worker_id"), state: text("state"), occurrences: integer("occurrences"), firstRaisedAt: time("first_raised_at"), lastRaisedAt: time("last_raised_at"), deliveredAt: time("delivered_at"), resolvedAt: time("resolved_at"), updatedAt: updated(), rowVersion: version(),
}, (t) => [uniqueIndex("notifications_open_dedup").on(t.dedupKey).where(sql`${t.state} = 'open'`), index("notifications_cursor").on(t.commitXid,t.seq), check("notifications_state", sql`${t.state} IN ('open','resolved')`), check("notifications_event_type", sql`${t.eventType} IN ('worker_offline','workflow_failed','task_blocked','approval_required','infrastructure_unavailable','backup_failed','retry_limit_exceeded','budget_exceeded','no_machine_available','no_eligible_agent','usage_limit_wait','cancel_unconfirmed','cleanup_stuck','decision_refused')`)]);

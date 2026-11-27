import { sql } from "drizzle-orm";
import { bigint, check, customType, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { projects } from "./projects.ts";
import { tasks } from "./tasks.ts";
import { deviceSessions } from "./device-sessions.ts";
import { taskDecisions } from "./decisions.ts";
import { owners } from "./owners.ts";

const xid8 = customType<{ data: string }>({ dataType: () => "xid8" });
const time = (name: string) => timestamp(name, { withTimezone: true });
const created = () => time("created_at").notNull().defaultNow();
const updated = () => time("updated_at").notNull().defaultNow();
const version = () => bigint("row_version", { mode: "bigint" }).notNull().default(sql`1`);

export const conversations = pgTable("conversations", {
	id: uuid("id").primaryKey(), source: text("source"), sessionRef: text("session_ref"), projectId: uuid("project_id").references(() => projects.id, { onDelete: "restrict" }), taskId: uuid("task_id").references(() => tasks.id, { onDelete: "restrict" }), state: text("state"), title: text("title"), createdAt: created(), lastMessageAt: time("last_message_at"), archivedAt: time("archived_at"), updatedAt: updated(), rowVersion: version(),
}, (t) => [uniqueIndex("conversations_source_session").on(t.source,t.sessionRef).where(sql`${t.sessionRef} IS NOT NULL`), check("conversations_source", sql`${t.source} IN ('rig_session','factory')`), check("conversations_state", sql`${t.state} IN ('active','waiting','permission_wait','ended')`)]);

export const messages = pgTable("messages", {
	id: uuid("id").primaryKey(), seq: bigint("seq", { mode: "bigint" }).generatedAlwaysAsIdentity().notNull(), commitXid: xid8("commit_xid").notNull().default(sql`pg_current_xact_id()`), conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "restrict" }), sourceKey: text("source_key"), kind: text("kind"), author: text("author"), body: text("body"), parsed: jsonb("parsed"), taskId: uuid("task_id").references(() => tasks.id, { onDelete: "restrict" }), attachmentIds: uuid("attachment_ids").array(), deviceSessionId: uuid("device_session_id").references(() => deviceSessions.id, { onDelete: "restrict" }), ownerId: uuid("owner_id").references(() => owners.id, { onDelete: "restrict" }), createdAt: created(),
}, (t) => [unique("messages_conversation_source").on(t.conversationId,t.sourceKey), index("messages_cursor").on(t.commitXid,t.seq), index("messages_conversation_seq").on(t.conversationId,t.seq), check("messages_kind", sql`${t.kind} IN ('text','result','question','approval','blocker','status','owner')`), check("messages_author", sql`${t.author} IN ('agent','owner','system')`), check("messages_owner_principal", sql`${t.author} <> 'owner' OR ${t.deviceSessionId} IS NOT NULL OR ${t.ownerId} IS NOT NULL`)]);

export const polls = pgTable("polls", {
	id: uuid("id").primaryKey(), conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "restrict" }), messageId: uuid("message_id").references(() => messages.id, { onDelete: "restrict" }), sourceKey: text("source_key"), options: jsonb("options"), taskId: uuid("task_id").references(() => tasks.id, { onDelete: "restrict" }), revisionNumber: integer("revision_number"), decisionId: uuid("decision_id").references(() => taskDecisions.id, { onDelete: "restrict" }), arbiter: text("arbiter").notNull(), state: text("state"), answerKey: text("answer_key"), answeredVia: text("answered_via"), answeredSessionId: uuid("answered_session_id").references(() => deviceSessions.id, { onDelete: "restrict" }), answeredAt: time("answered_at"), createdAt: created(), updatedAt: updated(), rowVersion: version(),
}, (t) => [unique("polls_conversation_source").on(t.conversationId,t.sourceKey), index("polls_state_created").on(t.state,t.createdAt), check("polls_arbiter", sql`${t.arbiter} IN ('hub','api')`), check("polls_task_arbiter", sql`(${t.taskId} IS NOT NULL) = (${t.arbiter} = 'api')`), check("polls_decision_arbiter", sql`${t.decisionId} IS NULL OR ${t.arbiter} = 'api'`), check("polls_state", sql`${t.state} IN ('open','answered','expired')`), check("polls_answered_via", sql`${t.answeredVia} IN ('client','telegram','api')`), check("polls_options", sql`jsonb_typeof(${t.options}) = 'array'`)]);

export const pollAnswerRequests = pgTable("poll_answer_requests", {
	id: uuid("id").primaryKey(), pollId: uuid("poll_id").references(() => polls.id, { onDelete: "restrict" }), deviceSessionId: uuid("device_session_id").references(() => deviceSessions.id, { onDelete: "restrict" }), idempotencyKey: text("idempotency_key"), answerKey: text("answer_key"), state: text("state"), refusalReason: text("refusal_reason"), createdAt: created(), deliveredAt: time("delivered_at"), decidedAt: time("decided_at"), hubRef: text("hub_ref"), updatedAt: updated(), rowVersion: version(),
}, (t) => [uniqueIndex("poll_answer_requests_session_key").on(t.deviceSessionId,t.idempotencyKey), index("poll_answer_requests_pending").on(t.createdAt).where(sql`${t.state} = 'pending'`), check("poll_answer_requests_state", sql`${t.state} IN ('pending','accepted','refused')`), check("poll_answer_requests_refusal", sql`${t.state} <> 'refused' OR ${t.refusalReason} IS NOT NULL`)]);

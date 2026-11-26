import { sql } from "drizzle-orm";
import { bigint, boolean, check, integer, pgTable, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import { projects } from "./projects.ts";
import { agents } from "./agents.ts";

export const tasks = pgTable("tasks", {
	id: uuid("id").primaryKey(), projectId: uuid("project_id").references(() => projects.id, { onDelete: "restrict" }),
	parentTaskId: uuid("parent_task_id").references((): AnyPgColumn => tasks.id, { onDelete: "restrict" }),
	title: text("title"), description: text("description"), priority: integer("priority"), status: text("status"), currentRevision: integer("current_revision"),
	createdBy: uuid("created_by"), assignedAgentId: uuid("assigned_agent_id").references(() => agents.id, { onDelete: "restrict" }),
	workflowId: text("workflow_id").unique(), workflowRunId: text("workflow_run_id"), blockKind: text("block_kind"), blockReason: text("block_reason"), blockHandler: text("block_handler"), resumeTo: text("resume_to"),
	pauseRequested: boolean("pause_requested"), stopping: boolean("stopping"), endUnconfirmed: boolean("end_unconfirmed"), originType: text("origin_type"),
	originTaskId: uuid("origin_task_id").references((): AnyPgColumn => tasks.id, { onDelete: "restrict" }), originRunId: uuid("origin_run_id"), originActor: text("origin_actor"), depth: integer("depth").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(), completedAt: timestamp("completed_at", { withTimezone: true }), deletedAt: timestamp("deleted_at", { withTimezone: true }), rowVersion: bigint("row_version", { mode: "bigint" }).notNull().default(sql`1`),
}, (t) => [
	uniqueIndex("tasks_standing_project").on(t.projectId).where(sql`${t.originType} = 'standing'`),
	check("tasks_workflow_id", sql`${t.workflowId} = 'task-' || ${t.id}`),
	check("tasks_status", sql`${t.status} IN ('CREATED','PLANNING','READY','WAITING_DEPENDENCIES','ASSIGNED','RUNNING','VERIFYING','AWAITING_APPROVAL','REWORK_REQUIRED','BLOCKED','ACCEPTED','REJECTED','CANCELLED','FAILED','PAUSED','CANCELLING')`),
	check("tasks_block_kind", sql`${t.blockKind} IN ('scope','dependency','execution','usage_limit','agent_question','check_environment','rework_limit')`),
	check("tasks_block_handler", sql`${t.blockHandler} IN ('chief_engineer','owner')`),
	check("tasks_resume_to", sql`${t.resumeTo} IN ('CREATED','PLANNING','READY','WAITING_DEPENDENCIES','ASSIGNED','RUNNING','VERIFYING','AWAITING_APPROVAL','REWORK_REQUIRED','BLOCKED','ACCEPTED','REJECTED','CANCELLED','FAILED','PAUSED','CANCELLING')`),
	check("tasks_origin_type", sql`${t.originType} IN ('owner','decomposition','agent_proposal','continuation','standing')`),
	check("tasks_block_kind_status", sql`(${t.status} = 'BLOCKED') = (${t.blockKind} IS NOT NULL)`),
	check("tasks_block_handler_status", sql`(${t.status} = 'BLOCKED') = (${t.blockHandler} IS NOT NULL)`),
	check("tasks_resume_status", sql`(${t.status} = 'PAUSED') = (${t.resumeTo} IS NOT NULL)`),
	check("tasks_depth_root", sql`(${t.parentTaskId} IS NULL) = (${t.depth} = 0)`),
	check("tasks_origin_required", sql`${t.originType} NOT IN ('decomposition','agent_proposal') OR (${t.originTaskId} IS NOT NULL AND ${t.originRunId} IS NOT NULL)`),
]);

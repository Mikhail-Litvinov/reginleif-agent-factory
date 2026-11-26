import { sql } from "drizzle-orm";
import { bigint, check, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { tasks } from "./tasks.ts";

export const taskDependencies = pgTable("task_dependencies", {
	taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "restrict" }), dependsOnTaskId: uuid("depends_on_task_id").notNull().references(() => tasks.id, { onDelete: "restrict" }),
	dependencyType: text("dependency_type"), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), removedAt: timestamp("removed_at", { withTimezone: true }), removedBy: uuid("removed_by"),
	updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(), rowVersion: bigint("row_version", { mode: "bigint" }).notNull().default(sql`1`),
}, (t) => [primaryKey({ columns: [t.taskId, t.dependsOnTaskId] }), check("task_dependencies_no_self", sql`${t.taskId} <> ${t.dependsOnTaskId}`), check("task_dependencies_type", sql`${t.dependencyType} = 'requires_accepted'`)]);

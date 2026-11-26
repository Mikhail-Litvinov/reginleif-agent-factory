import { sql } from "drizzle-orm";
import { bigint, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, check } from "drizzle-orm/pg-core";

export const projects = pgTable("projects", {
	id: uuid("id").primaryKey(), name: text("name"), description: text("description"),
	repositoryUrl: text("repository_url"), defaultBranch: text("default_branch"),
	workspacePolicy: text("workspace_policy"), settings: jsonb("settings"), priority: integer("priority"),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	archivedAt: timestamp("archived_at", { withTimezone: true }), deletedAt: timestamp("deleted_at", { withTimezone: true }),
	rowVersion: bigint("row_version", { mode: "bigint" }).notNull().default(sql`1`),
}, (t) => [uniqueIndex("projects_live_name").on(t.name).where(sql`${t.deletedAt} IS NULL`), check("projects_workspace_policy", sql`${t.workspacePolicy} = 'worktree'`)]);

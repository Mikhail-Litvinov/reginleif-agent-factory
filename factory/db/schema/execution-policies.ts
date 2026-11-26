import { boolean, integer, jsonb, numeric, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

export const executionPolicies = pgTable("execution_policies", {
	id: uuid("id").primaryKey(), projectId: uuid("project_id"), version: integer("version"),
	allowedCommands: text("allowed_commands").array(), allowedDirectories: text("allowed_directories").array(), allowedRepositories: text("allowed_repositories").array(),
	network: jsonb("network"), gitOperations: text("git_operations").array(), confirmationRequired: text("confirmation_required").array(), allowedTools: text("allowed_tools").array(),
	maxConcurrentTasks: integer("max_concurrent_tasks"), maxTasksPerAgent: integer("max_tasks_per_agent"), maxRunSeconds: integer("max_run_seconds"), maxTokens: integer("max_tokens"),
	maxCost: numeric("max_cost"), currency: text("currency"), maxAutoFixes: integer("max_auto_fixes"), maxAttempts: integer("max_attempts"), maxReworkRounds: integer("max_rework_rounds"),
	maxChildDepth: integer("max_child_depth"), maxChildrenPerTask: integer("max_children_per_task"), autoAcceptLowRisk: boolean("auto_accept_low_risk").notNull().default(false),
	createdBy: uuid("created_by"), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique("execution_policies_project_version").on(t.projectId, t.version)]);

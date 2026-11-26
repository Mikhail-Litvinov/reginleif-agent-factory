import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { agentRepo } from "./agents.ts";
import { auditRepo } from "./audit.ts";
import { ownerRepo } from "./owners.ts";
import { policyRepo } from "./policies.ts";
import { projectRepo } from "./projects.ts";
import { routingRuleRepo } from "./routing-rules.ts";
import { settingsRepo } from "./settings.ts";
import { taskRepo } from "./tasks.ts";
import { tokenRepo } from "./tokens.ts";
import { workerRepo } from "./workers.ts";

export const createRepo = (db: PostgresJsDatabase<any>) => ({
	projects: projectRepo(db),
	agents: agentRepo(db),
	workers: workerRepo(db),
	settings: settingsRepo(db),
	policies: policyRepo(db),
	routingRules: routingRuleRepo(db),
	tokens: tokenRepo(db),
	audit: auditRepo(db),
	owners: ownerRepo(db),
	tasks: taskRepo(db),
});

export type Repo = ReturnType<typeof createRepo>;
export type SettingsReader = Repo["settings"];

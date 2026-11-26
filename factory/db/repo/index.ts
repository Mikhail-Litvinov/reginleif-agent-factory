import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { agentRepo } from "./agents.ts";
import { auditRepo } from "./audit.ts";
import { confirmationRepo, decisionRepo, idempotencyKeyRepo, outboxRepo, taskEventRepo } from "./decisions.ts";
import { conversationRepo, deviceRepo, deviceSessionRepo, messageRepo, notificationRepo, pollAnswerRequestRepo, pollRepo } from "./client.ts";
import { ownerRepo } from "./owners.ts";
import { policyRepo } from "./policies.ts";
import { projectRepo } from "./projects.ts";
import { routingRuleRepo } from "./routing-rules.ts";
import { settingsRepo } from "./settings.ts";
import { taskRepo } from "./tasks.ts";
import { tokenRepo } from "./tokens.ts";
import { workerRepo } from "./workers.ts";

type RepoParts = {
	projects: ReturnType<typeof projectRepo>;
	agents: ReturnType<typeof agentRepo>;
	workers: ReturnType<typeof workerRepo>;
	settings: ReturnType<typeof settingsRepo>;
	policies: ReturnType<typeof policyRepo>;
	routingRules: ReturnType<typeof routingRuleRepo>;
	tokens: ReturnType<typeof tokenRepo>;
	audit: ReturnType<typeof auditRepo>;
	owners: ReturnType<typeof ownerRepo>;
	tasks: ReturnType<typeof taskRepo>;
	decisions: ReturnType<typeof decisionRepo>;
	taskEvents: ReturnType<typeof taskEventRepo>;
	outbox: ReturnType<typeof outboxRepo>;
	confirmations: ReturnType<typeof confirmationRepo>;
	idempotencyKeys: ReturnType<typeof idempotencyKeyRepo>;
	devices: ReturnType<typeof deviceRepo>;
	deviceSessions: ReturnType<typeof deviceSessionRepo>;
	notifications: ReturnType<typeof notificationRepo>;
	conversations: ReturnType<typeof conversationRepo>;
	messages: ReturnType<typeof messageRepo>;
	polls: ReturnType<typeof pollRepo>;
	pollAnswerRequests: ReturnType<typeof pollAnswerRequestRepo>;
};

export type Repo = RepoParts & { transaction<T>(operation: (transactionRepo: RepoParts) => Promise<T>): Promise<T> };

export const createRepo = (db: PostgresJsDatabase<any>): Repo => ({
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
	decisions: decisionRepo(db),
	taskEvents: taskEventRepo(db),
	outbox: outboxRepo(db),
	confirmations: confirmationRepo(db),
	idempotencyKeys: idempotencyKeyRepo(db),
	devices: deviceRepo(db),
	deviceSessions: deviceSessionRepo(db),
	notifications: notificationRepo(db),
	conversations: conversationRepo(db),
	messages: messageRepo(db),
	polls: pollRepo(db),
	pollAnswerRequests: pollAnswerRequestRepo(db),
	transaction: <T>(operation: (transactionRepo: RepoParts) => Promise<T>): Promise<T> =>
		db.transaction((tx) => operation(createRepo(tx))),
});

export type SettingsReader = Repo["settings"];

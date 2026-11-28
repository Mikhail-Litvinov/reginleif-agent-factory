// SelectAgent (temporal.md "Activities"): local, key task id + attempt. The decision is stored as a task event under
// that key before anything else uses it, so a retry (also after a crash between the two steps) returns the stored one
// and never routes again on changed load. No eligible agent: the decision is stored too, then the activity fails
// non-retryably ("no agent allowed by profile"); the workflow leaves the task ASSIGNED and notifies (`no_eligible_agent`).
import { randomUUID } from "node:crypto";
import { ApplicationFailure } from "@temporalio/activity";
import type { Repo } from "../../db/repo/index.ts";
import type { routingReadRepo } from "../../db/repo/routing-reads.ts";
import { route, type RoutingDecision } from "../routing.ts";

export const NO_ELIGIBLE_AGENT = "NoEligibleAgent";
export const NO_AGENT_MESSAGE = "no agent allowed by profile";
export const ROUTED_EVENT = "agent_routed";

export interface SelectAgentInput { taskId: string; attempt: number }
export type SelectAgentDeps = Pick<Repo, "tasks" | "agents" | "workers" | "policies" | "routingRules" | "taskEvents"> & { reads: ReturnType<typeof routingReadRepo> };

export const selectAgentKey = (taskId: string, attempt: number): string => `select-agent:${taskId}:${attempt}`;

const settle = (decision: RoutingDecision): RoutingDecision & { chosen: NonNullable<RoutingDecision["chosen"]> } => {
	if (decision.chosen === null) throw ApplicationFailure.nonRetryable(NO_AGENT_MESSAGE, NO_ELIGIBLE_AGENT, decision.failedFilters, decision.reason);
	return decision as RoutingDecision & { chosen: NonNullable<RoutingDecision["chosen"]> };
};

export const SelectAgent = async (deps: SelectAgentDeps, { taskId, attempt }: SelectAgentInput) => {
	const dedupeKey = selectAgentKey(taskId, attempt);
	const stored = await deps.reads.eventByDedupe(taskId, dedupeKey);
	if (stored) return settle(stored.payload as RoutingDecision);
	const task = await deps.tasks.get(taskId);
	if (!task) throw ApplicationFailure.nonRetryable(`unknown task ${taskId}`, "UnknownTask");
	const revision = task.currentRevision === null ? undefined : await deps.tasks.getRevision(taskId, task.currentRevision);
	const projectId = task.projectId;
	const [agents, workers, policy, projectRules, globalRules, held, workerActive, implementerProviders, pastSuccesses, allowedAgents] = await Promise.all([
		deps.agents.list({ enabled: true }), deps.workers.list(), deps.policies.effective(projectId),
		projectId ? deps.routingRules.list(projectId) : Promise.resolve([]), deps.routingRules.list(null),
		projectId ? deps.reads.holding(projectId, taskId) : Promise.resolve({ projectActive: 0, agentActive: {} }),
		deps.reads.workerActive(), deps.reads.implementerProviders(taskId), deps.reads.pastSuccesses(), deps.reads.allowedAgents(taskId),
	]);
	const decision = route({
		task: { id: taskId, priority: task.priority, constraints: revision?.constraints ?? null },
		agents, workers, policy: policy ?? null, rules: [...projectRules, ...globalRules],
		load: { ...held, workerActive }, allowedAgents, implementerProviders, pastSuccesses,
	});
	// persist is idempotent on (task, dedupe key): a concurrent twin gets the row that won, and its decision is used.
	const row = await deps.taskEvents.persist({
		id: randomUUID(), taskId, runId: null, eventType: ROUTED_EVENT, actorType: "workflow", actorId: null,
		payload: decision, correlationId: null, dedupeKey,
	});
	return settle(row.payload as RoutingDecision);
};

// SelectAgent stages (agent-adapters.md "Routing"; modules.md F/control/routing.ts): 1 hard filters, 2 ranking,
// 3 the stored decision (built here, written by the activity). Pure: it takes plain data and never imports adapter
// code. Adapter capabilities are data only (jsonb of `agents.capabilities` / `workers.capabilities`).
//
// Data shapes this module reads (all optional; a missing field means "no claim", never a guess):
//  - task revision `constraints`: `{ role?: "implementer" | "reviewer", requiredCapability?: string, platform?: string }`
//  - `agents.capabilities`: `{ verified?: string[], tools?: string[], needsNetwork?: boolean, platforms?: string[], cost?: number }`
//    `verified` lists capabilities `validateEnvironment` confirmed; a declared but unchecked one is not listed and so
//    never satisfies the filter (agent-adapters.md getCapabilities).
//  - `agents.configuration`: `{ gateBlocked?: boolean }` the account and model gate (set by the usage-limit handling).
//  - `workers.capabilities`: `{ adapters?: string[] }` adapter types usable on that machine.
//  - `execution_policies.network`: `{ mode?: "none" | "restricted" | "full" }`; `allowedTools` null means unrestricted.
//  - `routing_rules.match`: `{ role?: string, requiredCapability?: string, priorityAtLeast?: number }`; `{}` matches all.

export interface RoutingAgent {
	id: string;
	provider: string | null;
	adapterType: string | null;
	capabilities: unknown;
	enabled: boolean | null;
	concurrencyLimit: number | null;
	configuration: unknown;
}
export interface RoutingWorker {
	id: string;
	platform: string | null;
	capabilities: unknown;
	status: string | null;
	concurrencyLimit: number | null;
}
export interface RoutingPolicy {
	allowedTools: string[] | null;
	network: unknown;
	maxConcurrentTasks: number | null;
	maxTasksPerAgent: number | null;
	maxCost: string | null;
}
export interface RoutingRule {
	id: string;
	position: number | null;
	match: unknown;
	preferredAgentIds: string[] | null;
}
export interface RoutingTask {
	id: string;
	priority: number | null;
	/** Task revision `constraints`. */
	constraints: unknown;
}
export interface RoutingLoad {
	/** Tasks of the project that hold an agent now (ASSIGNED, RUNNING, VERIFYING), this task excluded. */
	projectActive: number;
	agentActive: Readonly<Record<string, number>>;
	workerActive: Readonly<Record<string, number>>;
}
export interface RoutingInput {
	task: RoutingTask;
	agents: readonly RoutingAgent[];
	workers: readonly RoutingWorker[];
	policy: RoutingPolicy | null;
	/** In precedence order: the project's rules by position, then the global rules. */
	rules: readonly RoutingRule[];
	load: RoutingLoad;
	/** `allow_agent` owner decision for a review: the only agents allowed. Null when the owner did not restrict. */
	allowedAgents: readonly string[] | null;
	/** Providers of the implementer runs of this task (D20: a reviewer must differ). */
	implementerProviders: readonly string[];
	/** Accepted runs per agent: breaks a tie in the ranking. */
	pastSuccesses: Readonly<Record<string, number>>;
}

export type FilterName =
	| "no_agents" | "agent_enabled" | "capability" | "worker_online" | "adapter_on_worker" | "platform" | "profile_tools" | "profile_network"
	| "project_limit" | "agent_task_limit" | "agent_concurrency" | "worker_concurrency" | "budget" | "gate" | "allowed_agents" | "provider_differs";

export interface Failure { agentId: string | null; workerId: string | null; filter: FilterName }
export interface Candidate { agentId: string; workerId: string; ruleRank: number | null; cost: number | null; load: number; pastSuccesses: number }

/** The stored decision (agent-adapters.md): inputs, filters, ranking, chosen agent, reason. */
export interface RoutingDecision {
	inputs: { taskId: string; priority: number | null; role: string; requiredCapability: string | null; agents: number; workers: number };
	failures: Failure[];
	failedFilters: FilterName[];
	ranking: Candidate[];
	chosen: { agentId: string; workerId: string } | null;
	reason: string;
}

const obj = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const strings = (value: unknown): string[] | null => (Array.isArray(value) && value.every((v) => typeof v === "string") ? (value as string[]) : null);

const ruleMatches = (match: unknown, role: string, capability: string | null, priority: number | null): boolean => {
	const m = obj(match);
	if (typeof m.role === "string" && m.role !== role) return false;
	if (typeof m.requiredCapability === "string" && m.requiredCapability !== capability) return false;
	if (typeof m.priorityAtLeast === "number" && (priority ?? 0) < m.priorityAtLeast) return false;
	return true;
};

export const route = (input: RoutingInput): RoutingDecision => {
	const constraints = obj(input.task.constraints);
	const role = constraints.role === "reviewer" ? "reviewer" : "implementer";
	const capability = typeof constraints.requiredCapability === "string" ? constraints.requiredCapability : null;
	const platform = typeof constraints.platform === "string" ? constraints.platform : null;
	const failures: Failure[] = [];
	const fail = (agentId: string | null, workerId: string | null, filter: FilterName): void => void failures.push({ agentId, workerId, filter });
	const policy = input.policy;
	const inputs = { taskId: input.task.id, priority: input.task.priority, role, requiredCapability: capability, agents: input.agents.length, workers: input.workers.length };
	const finish = (ranking: Candidate[]): RoutingDecision => {
		const failedFilters = [...new Set(failures.map((f) => f.filter))];
		const best = ranking[0];
		return best
			? { inputs, failures, failedFilters, ranking, chosen: { agentId: best.agentId, workerId: best.workerId }, reason: `chosen ${best.agentId} on ${best.workerId} of ${ranking.length} eligible` }
			: { inputs, failures, failedFilters, ranking, chosen: null, reason: `no eligible agent; failed filters: ${failedFilters.join(", ") || "none"}` };
	};
	if (input.agents.length === 0) {
		fail(null, null, "no_agents");
		return finish([]);
	}
	// Project limit is the same for every agent: one failure row, not one per agent.
	const projectFull = policy?.maxConcurrentTasks != null && input.load.projectActive >= policy.maxConcurrentTasks;
	if (projectFull) fail(null, null, "project_limit");
	const ranking: Candidate[] = [];
	for (const agent of input.agents) {
		const caps = obj(agent.capabilities);
		const config = obj(agent.configuration);
		if (agent.enabled !== true) { fail(agent.id, null, "agent_enabled"); continue; }
		if (capability !== null && !(strings(caps.verified) ?? []).includes(capability)) { fail(agent.id, null, "capability"); continue; }
		const tools = strings(caps.tools) ?? [];
		if (policy?.allowedTools != null && !tools.every((t) => policy.allowedTools!.includes(t))) { fail(agent.id, null, "profile_tools"); continue; }
		if (caps.needsNetwork === true && obj(policy?.network).mode === "none") { fail(agent.id, null, "profile_network"); continue; }
		if (config.gateBlocked === true) { fail(agent.id, null, "gate"); continue; }
		const cost = typeof caps.cost === "number" ? caps.cost : null;
		if (policy?.maxCost != null && cost !== null && cost > Number(policy.maxCost)) { fail(agent.id, null, "budget"); continue; }
		if (role === "reviewer" && input.allowedAgents !== null && !input.allowedAgents.includes(agent.id)) { fail(agent.id, null, "allowed_agents"); continue; }
		if (role === "reviewer" && agent.provider !== null && input.implementerProviders.includes(agent.provider)) { fail(agent.id, null, "provider_differs"); continue; }
		const agentActive = input.load.agentActive[agent.id] ?? 0;
		if (policy?.maxTasksPerAgent != null && agentActive >= policy.maxTasksPerAgent) { fail(agent.id, null, "agent_task_limit"); continue; }
		if (agent.concurrencyLimit != null && agentActive >= agent.concurrencyLimit) { fail(agent.id, null, "agent_concurrency"); continue; }
		const online = input.workers.filter((w) => w.status === "online");
		if (online.length === 0) { fail(agent.id, null, "worker_online"); continue; }
		const agentPlatforms = strings(caps.platforms);
		for (const worker of online) {
			const adapters = strings(obj(worker.capabilities).adapters) ?? [];
			if (agent.adapterType === null || !adapters.includes(agent.adapterType)) { fail(agent.id, worker.id, "adapter_on_worker"); continue; }
			if ((platform !== null && worker.platform !== platform) || (agentPlatforms !== null && (worker.platform === null || !agentPlatforms.includes(worker.platform)))) { fail(agent.id, worker.id, "platform"); continue; }
			const workerActive = input.load.workerActive[worker.id] ?? 0;
			if (worker.concurrencyLimit != null && workerActive >= worker.concurrencyLimit) { fail(agent.id, worker.id, "worker_concurrency"); continue; }
			if (projectFull) continue;
			// `rules` arrive in precedence order (the project's by position, then the global ones); the first hit wins.
			const hit = input.rules.findIndex((r) => ruleMatches(r.match, role, capability, input.task.priority) && (r.preferredAgentIds ?? []).includes(agent.id));
			const rule = hit < 0 ? null : hit;
			ranking.push({ agentId: agent.id, workerId: worker.id, ruleRank: rule, cost, load: agentActive + workerActive, pastSuccesses: input.pastSuccesses[agent.id] ?? 0 });
		}
	}
	// Order: owner preference (a ranked rule first, lower position first), cheaper (unknown cost last), less loaded,
	// more past successes, then ids so the order is total and a retry on equal inputs picks the same pair.
	const cmp = (x: number | null, y: number | null): number => (x === y ? 0 : x === null ? 1 : y === null ? -1 : x - y);
	ranking.sort((a, b) =>
		cmp(a.ruleRank, b.ruleRank) || cmp(a.cost, b.cost) || a.load - b.load || b.pastSuccesses - a.pastSuccesses ||
		a.agentId.localeCompare(b.agentId) || a.workerId.localeCompare(b.workerId));
	return finish(ranking);
};

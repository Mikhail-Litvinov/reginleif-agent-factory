import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTIVITIES, allTimeoutKeys, createActivityCatalog } from "../control/activity-catalog.ts";
import { PrepareTask, UNKNOWN_TASK } from "../control/activities/prepare-task.ts";
import { DEPENDENCY_CYCLE, ResolveDependencies, findCycle } from "../control/activities/resolve-dependencies.ts";
import { route, type RoutingAgent, type RoutingInput, type RoutingWorker } from "../control/routing.ts";

// Numbers below are arbitrary test fixtures chosen only for their order (limit 1 vs load 1, cost 1 < 2, rule index 0 < 1);
// none is a product default. Product limits come from execution_policies / agents.concurrency_limit rows (database.md).
const agent = (id: string, over: Partial<RoutingAgent> = {}): RoutingAgent => ({
	id, provider: `provider-${id}`, adapterType: "cli", enabled: true, concurrencyLimit: null, configuration: {},
	capabilities: { verified: ["code"], tools: ["edit"], cost: 1 }, ...over,
});
const worker = (id: string, over: Partial<RoutingWorker> = {}): RoutingWorker => ({
	id, platform: "linux", status: "online", concurrencyLimit: null, capabilities: { adapters: ["cli"] }, ...over,
});
const base = (over: Partial<RoutingInput> = {}): RoutingInput => ({
	task: { id: "t1", priority: 5, constraints: { requiredCapability: "code" } },
	agents: [agent("a1")], workers: [worker("w1")], policy: null, rules: [],
	load: { projectActive: 0, agentActive: {}, workerActive: {} }, allowedAgents: null, implementerProviders: [], pastSuccesses: {}, ...over,
});
const policy = (over: object = {}) => ({ allowedTools: null, network: {}, maxConcurrentTasks: null, maxTasksPerAgent: null, maxCost: null, ...over });

test("one eligible agent is chosen with a stored-decision shape", () => {
	const d = route(base());
	assert.deepEqual(d.chosen, { agentId: "a1", workerId: "w1" });
	assert.equal(d.inputs.taskId, "t1");
	assert.equal(d.inputs.priority, 5);
	assert.deepEqual(d.failedFilters, []);
});

test("hard filters each refuse and name themselves", () => {
	const cases: [string, Partial<RoutingInput>][] = [
		["agent_enabled", { agents: [agent("a1", { enabled: false })] }],
		["capability", { task: { id: "t1", priority: 1, constraints: { requiredCapability: "gpu" } } }],
		["worker_online", { workers: [worker("w1", { status: "offline" })] }],
		["adapter_on_worker", { workers: [worker("w1", { capabilities: { adapters: [] } })] }],
		["platform", { task: { id: "t1", priority: 1, constraints: { platform: "windows" } } }],
		["profile_tools", { policy: policy({ allowedTools: [] }) }],
		["profile_network", { agents: [agent("a1", { capabilities: { verified: ["code"], needsNetwork: true } })], policy: policy({ network: { mode: "none" } }) }],
		["gate", { agents: [agent("a1", { configuration: { gateBlocked: true } })] }],
		["budget", { policy: policy({ maxCost: "0.5" }) }],
	];
	for (const [filter, over] of cases) {
		const d = route(base({ ...over, policy: (over.policy ?? null) as RoutingInput["policy"] }));
		assert.equal(d.chosen, null, filter);
		assert.ok(d.failedFilters.includes(filter as never), `${filter}: ${d.failedFilters.join()}`);
	}
});

test("queue limits: project, per agent, agent and worker concurrency", () => {
	const load = (over: object) => ({ projectActive: 0, agentActive: {}, workerActive: {}, ...over });
	// limit 1 with 1 active means full (>=), the boundary the code tests.
	assert.deepEqual(route(base({ policy: policy({ maxConcurrentTasks: 1 }), load: load({ projectActive: 1 }) })).failedFilters, ["project_limit"]);
	assert.equal(route(base({ policy: policy({ maxConcurrentTasks: 2 }), load: load({ projectActive: 1 }) })).chosen?.agentId, "a1");
	assert.deepEqual(route(base({ policy: policy({ maxTasksPerAgent: 1 }), load: load({ agentActive: { a1: 1 } }) })).failedFilters, ["agent_task_limit"]);
	assert.deepEqual(route(base({ agents: [agent("a1", { concurrencyLimit: 1 })], load: load({ agentActive: { a1: 1 } }) })).failedFilters, ["agent_concurrency"]);
	assert.deepEqual(route(base({ workers: [worker("w1", { concurrencyLimit: 1 })], load: load({ workerActive: { w1: 1 } }) })).failedFilters, ["worker_concurrency"]);
});

test("priority: a rule with priorityAtLeast prefers its agent only for a task of that priority", () => {
	const agents = [agent("a1"), agent("a2")];
	const rules = [{ id: "r", position: 0, match: { priorityAtLeast: 5 }, preferredAgentIds: ["a2"] }];
	assert.equal(route(base({ agents, rules, task: { id: "t", priority: 5, constraints: {} } })).chosen?.agentId, "a2");
	assert.equal(route(base({ agents, rules, task: { id: "t", priority: 4, constraints: {} } })).chosen?.agentId, "a1");
});

test("ranking order: rule, then cost, then load, then past successes", () => {
	const cheap = agent("b", { capabilities: { verified: [], cost: 1 } });
	const dear = agent("a", { capabilities: { verified: [], cost: 2 } });
	const none = { id: "t", priority: 1, constraints: {} };
	assert.equal(route(base({ task: none, agents: [dear, cheap] })).chosen?.agentId, "b");
	assert.equal(route(base({ task: none, agents: [dear, cheap], rules: [{ id: "r", position: 0, match: {}, preferredAgentIds: ["a"] }] })).chosen?.agentId, "a");
	const same = [agent("a"), agent("b")];
	assert.equal(route(base({ task: none, agents: same, load: { projectActive: 0, agentActive: { a: 1 }, workerActive: {} } })).chosen?.agentId, "b");
	assert.equal(route(base({ task: none, agents: same, pastSuccesses: { b: 3 } })).chosen?.agentId, "b");
	assert.equal(route(base({ task: none, agents: same })).chosen?.agentId, "a");
});

test("review: provider must differ from the implementer and allow_agent restricts", () => {
	const review = { id: "t", priority: 1, constraints: { role: "reviewer" } };
	const agents = [agent("a1", { provider: "p1" }), agent("a2", { provider: "p2" })];
	assert.equal(route(base({ task: review, agents, implementerProviders: ["p1"] })).chosen?.agentId, "a2");
	assert.deepEqual(route(base({ task: review, agents: [agents[0]!], implementerProviders: ["p1"] })).failedFilters, ["provider_differs"]);
	assert.deepEqual(route(base({ task: review, agents, allowedAgents: ["a1"] })).chosen?.agentId, "a1");
});

test("no agent: documented result with the failed-filter list", () => {
	const none = route(base({ agents: [] }));
	assert.equal(none.chosen, null);
	assert.deepEqual(none.failedFilters, ["no_agents"]);
	const blocked = route(base({ agents: [agent("a1", { enabled: false }), agent("a2", { configuration: { gateBlocked: true } })] }));
	assert.match(blocked.reason, /^no eligible agent; failed filters: agent_enabled, gate$/);
});

test("route is deterministic on equal inputs", () => {
	const input = base({ agents: [agent("a"), agent("b")], workers: [worker("w1"), worker("w2")] });
	assert.deepEqual(route(input), route(input));
});

const rejects = async (p: Promise<unknown>, type: string) =>
	assert.rejects(p, (e: { type?: string; nonRetryable?: boolean }) => e.type === type && e.nonRetryable === true);

const repoOf = (edges: Record<string, string[]>, statuses: Record<string, string> = {}) => ({
	tasks: {
		get: async (id: string) => (id === "missing" ? undefined : { id, projectId: "p", title: "T", description: null, priority: 1, status: statuses[id] ?? "READY" }),
		getRevision: async (_id: string, n: number) => (n === 1 ? { requirements: "r", acceptanceCriteria: [], constraints: {} } : undefined),
		dependencies: async (id: string) => (edges[id] ?? []).map((d) => ({ taskId: id, dependsOnTaskId: d })),
	},
}) as never;

test("PrepareTask returns the snapshot; unknown task or revision is non-retryable", async () => {
	const ok = await PrepareTask(repoOf({}), { taskId: "t", revision: 1 });
	assert.equal(ok.requirements, "r");
	await rejects(PrepareTask(repoOf({}), { taskId: "missing", revision: 1 }), UNKNOWN_TASK);
	await rejects(PrepareTask(repoOf({}), { taskId: "t", revision: 9 }), UNKNOWN_TASK);
});

test("ResolveDependencies splits open from accepted; a cycle is refused non-retryably", async () => {
	const r = await ResolveDependencies(repoOf({ t: ["done", "wait"] }, { done: "ACCEPTED" }), { taskId: "t" });
	assert.deepEqual(r, { open: ["wait"], satisfied: ["done"] });
	await rejects(ResolveDependencies(repoOf({ t: ["u"], u: ["v"], v: ["t"] }), { taskId: "t" }), DEPENDENCY_CYCLE);
	assert.deepEqual(await findCycle(async (id) => ({ a: ["b"], b: ["a"] } as Record<string, string[]>)[id] ?? [], "a"), ["a", "b", "a"]);
	assert.equal(await findCycle(async (id) => ({ a: ["b", "c"], b: ["c"] } as Record<string, string[]>)[id] ?? [], "a"), null);
});

test("ActivityCatalog gives the three activities timeouts from settings, none by default", () => {
	const keys = allTimeoutKeys();
	for (const name of ["PrepareTask", "ResolveDependencies", "SelectAgent"] as const) {
		for (const kind of ACTIVITIES[name].kinds) assert.ok(keys.includes(`act.${name}.${kind}`));
	}
	assert.throws(() => createActivityCatalog({}).timeouts("SelectAgent"), /must be a positive number/);
	// 7 s is a test fixture; the product value is set by the measuring phase (settings act.*).
	const snapshot = Object.fromEntries(keys.map((k) => [k, 7]));
	assert.deepEqual(Object.values(createActivityCatalog(snapshot).timeouts("SelectAgent")), ACTIVITIES.SelectAgent.kinds.map(() => 7));
});

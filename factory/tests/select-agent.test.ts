import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "../db/migrate.ts";
import { createRepo } from "../db/repo/index.ts";
import { routingReadRepo } from "../db/repo/routing-reads.ts";
import { SelectAgent, NO_ELIGIBLE_AGENT, selectAgentKey } from "../control/activities/select-agent.ts";
import { connectBench, createDatabaseBench } from "./database-bench.ts";

const benchPromise = createDatabaseBench(import.meta.url);
let bench: Awaited<typeof benchPromise>;
let migrationClient: ReturnType<typeof connectBench>;
let repo: ReturnType<typeof createRepo>;
let reads: ReturnType<typeof routingReadRepo>;
const projectId = "51000000-0000-7000-8000-000000000001";
const taskId = "51000000-0000-7000-8000-000000000002";

before(async () => {
	bench = await benchPromise;
	await migrate({ url: bench.migratorUrl });
	migrationClient = connectBench(bench.migratorUrl);
	const db = drizzle(migrationClient);
	repo = createRepo(db);
	reads = routingReadRepo(db);
	await repo.projects.create({ id: projectId, name: "select-agent", workspacePolicy: "worktree" });
	await repo.tasks.create({ id: taskId, projectId, title: "route me", priority: 1 }, {
		id: "51000000-0000-7000-8000-000000000003", requirements: "r", acceptanceCriteria: [], constraints: {},
	});
});

after(async () => {
	await migrationClient?.end();
	await bench?.dispose();
});

test("SelectAgent with no agent stores the decision and fails non-retryably; the retry fails from the stored one", async () => {
	const deps = { ...repo, reads };
	const noAgent = (e: { type?: string; nonRetryable?: boolean }) => e.type === NO_ELIGIBLE_AGENT && e.nonRetryable === true;
	await assert.rejects(SelectAgent(deps, { taskId, attempt: 1 }), noAgent);
	const stored = await reads.eventByDedupe(taskId, selectAgentKey(taskId, 1));
	assert.ok(stored);
	assert.deepEqual((stored.payload as { failedFilters: string[] }).failedFilters, ["no_agents"]);
	await assert.rejects(SelectAgent(deps, { taskId, attempt: 1 }), noAgent);
	assert.equal((await repo.taskEvents.stream({ below: "18446744073709551615", taskId })).filter((r) => r.dedupeKey === selectAgentKey(taskId, 1)).length, 1);
});

test("a retry reuses the stored decision even after the agents changed", async () => {
	const deps = { ...repo, reads };
	const agentId = "51000000-0000-7000-8000-000000000010";
	const workerId = "51000000-0000-7000-8000-000000000011";
	await migrationClient`INSERT INTO workers (id, name, platform, status, capabilities) VALUES (${workerId}, 'w51', 'linux', 'online', ${JSON.stringify({ adapters: ["cli"] })}::jsonb)`;
	await migrationClient`INSERT INTO agents (id, name, provider, adapter_type, enabled, capabilities) VALUES (${agentId}, 'a51', 'p51', 'cli', true, ${"{}"}::jsonb)`;
	const first = await SelectAgent(deps, { taskId, attempt: 2 });
	assert.deepEqual(first.chosen, { agentId, workerId });
	await migrationClient`UPDATE agents SET enabled = false WHERE id = ${agentId}`;
	const retry = await SelectAgent(deps, { taskId, attempt: 2 });
	assert.deepEqual(retry, first);
	// A new attempt routes afresh and now finds nobody.
	await assert.rejects(SelectAgent(deps, { taskId, attempt: 3 }), (e: { type?: string }) => e.type === NO_ELIGIBLE_AGENT);
});

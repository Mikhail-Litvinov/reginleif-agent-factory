import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { drizzle } from "drizzle-orm/postgres-js";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { allTimeoutKeys, createActivityCatalog } from "../control/activity-catalog.ts";
import { createControlActivities, DecisionNotFoundError, ReadDecision, RecordDecisionOutcome, refusalCodes, type RefusalCode } from "../control/activities/index.ts";
import { migrate } from "../db/migrate.ts";
import { createRepo, type Repo } from "../db/repo/index.ts";
import { connectBench, createDatabaseBench } from "./database-bench.ts";
import { startTimeSkipping, withWorker, workflowsPathOf } from "./temporal/bench.ts";

const benchPromise = createDatabaseBench(import.meta.url);
let bench: Awaited<typeof benchPromise>;
let migratorClient: ReturnType<typeof connectBench>;
let controlClient: ReturnType<typeof connectBench>;
let migratorRepo: Repo;
let controlRepo: Repo;

const ids = (n: number): string => `27000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const owner = ids(1);
const disabledOwner = ids(2);
const project = ids(3);
const task = ids(4);
let counter = 100;

// Inserts a decision and its outbox row the way the API does (one pair), as the migrator role.
const seedDecision = async (kind: string, extra: { revisionNumber?: number | null; payload?: unknown; actorId?: string } = {}) => {
	const decisionId = ids(counter++);
	const outboxId = ids(counter++);
	const { decision } = await migratorRepo.decisions.record({
		decision: { id: decisionId, taskId: task, kind, actorId: extra.actorId ?? owner, channel: "client", idempotencyKey: `key-${decisionId}`, requestHash: "h", deliveryState: "recorded", outboxId, revisionNumber: extra.revisionNumber ?? null, payload: extra.payload ?? {} },
		outbox: { id: outboxId, kind: "deliver_decision", taskId: task, decisionId, payload: { decision_id: decisionId }, state: "pending", attempts: 0 },
	});
	return decision;
};

before(async () => {
	bench = await benchPromise;
	await migrate({ url: bench.migratorUrl });
	migratorClient = connectBench(bench.migratorUrl);
	migratorRepo = createRepo(drizzle(migratorClient));
	await migratorClient`INSERT INTO owners (id, name) VALUES (${owner}, 'active owner')`;
	await migratorClient`INSERT INTO owners (id, name, disabled_at) VALUES (${disabledOwner}, 'disabled owner', now())`;
	await migratorRepo.projects.create({ id: project, name: "activities-test", workspacePolicy: "worktree" });
	await migratorRepo.tasks.create({ id: task, projectId: project, title: "activities-test", priority: 1 }, { id: ids(5), requirements: "test", acceptanceCriteria: [], constraints: {} });
	controlClient = connectBench(bench.controlUrl);
	controlRepo = createRepo(drizzle(controlClient));
});

after(async () => {
	await controlClient?.end();
	await migratorClient?.end();
	await bench?.dispose();
});

describe("RecordDecisionOutcome", () => {
	test("the same call twice has one effect: one row_version bump, the first outcome stays", async () => {
		const decision = await seedDecision("pause");
		const first = await RecordDecisionOutcome(controlRepo, { decisionId: decision.id, outcome: "applied" });
		const afterFirst = await controlRepo.decisions.get(decision.id);
		const second = await RecordDecisionOutcome(controlRepo, { decisionId: decision.id, outcome: "applied" });
		const contradicting = await RecordDecisionOutcome(controlRepo, { decisionId: decision.id, outcome: "refused", refusalReason: "task_closed" });
		const afterAll = await controlRepo.decisions.get(decision.id);
		assert.equal(first.replayed, false);
		assert.equal(second.replayed, true);
		assert.equal(contradicting.replayed, true);
		assert.equal(contradicting.deliveryState, "applied");
		assert.equal(afterFirst?.rowVersion, BigInt(decision.rowVersion) + 1n);
		assert.equal(afterAll?.rowVersion, afterFirst?.rowVersion);
		assert.equal(afterAll?.deliveryState, "applied");
		assert.ok(afterAll?.resolvedAt && afterAll.deliveredAt);
	});

	test("a refused outcome stores its refusal code", async () => {
		const decision = await seedDecision("pause");
		const result = await RecordDecisionOutcome(controlRepo, { decisionId: decision.id, outcome: "refused", refusalReason: "not_allowed_in_state" });
		assert.equal(result.deliveryState, "refused");
		assert.equal((await controlRepo.decisions.get(decision.id))?.refusalReason, "not_allowed_in_state");
	});

	test("refuses a refused outcome without a known code, an applied one with a reason, and an unknown decision", async () => {
		const decision = await seedDecision("pause");
		await assert.rejects(RecordDecisionOutcome(controlRepo, { decisionId: decision.id, outcome: "refused" }), /refusal code/);
		await assert.rejects(RecordDecisionOutcome(controlRepo, { decisionId: decision.id, outcome: "refused", refusalReason: "because" }), /refusal code/);
		await assert.rejects(RecordDecisionOutcome(controlRepo, { decisionId: decision.id, outcome: "applied", refusalReason: "task_closed" }), /no refusal reason/);
		await assert.rejects(RecordDecisionOutcome(controlRepo, { decisionId: ids(9999), outcome: "applied" }), DecisionNotFoundError);
		assert.equal((await controlRepo.decisions.get(decision.id))?.deliveryState, "recorded");
	});

	test("af_control cannot write columns outside the four outcome columns, nor delete", async () => {
		const decision = await seedDecision("pause");
		for (const column of ["kind", "payload", "task_id", "revision_number", "outbox_id", "recorded_at"]) {
			await assert.rejects(controlClient.unsafe(`UPDATE task_decisions SET ${column} = ${column} WHERE id = '${decision.id}'`), (e: unknown) => (e as { code?: string }).code === "42501", column);
		}
		await assert.rejects(controlClient`DELETE FROM task_decisions WHERE id = ${decision.id}`, (e: unknown) => (e as { code?: string }).code === "42501");
		const [row] = await migratorClient`SELECT kind, delivery_state FROM task_decisions WHERE id = ${decision.id}`;
		assert.deepEqual({ ...row }, { kind: "pause", delivery_state: "recorded" });
	});
});

describe("ReadDecision refusals (database)", () => {
	const refusalOf = async (id: string) => (await ReadDecision(controlRepo, { decisionId: id })).refusal;

	test("an acceptable decision has no refusal and the read changes nothing", async () => {
		const decision = await seedDecision("pause");
		const before = await controlRepo.decisions.get(decision.id);
		const result = await ReadDecision(controlRepo, { decisionId: decision.id });
		assert.deepEqual({ refusal: result.refusal, taskStatus: result.taskStatus, currentRevision: result.currentRevision }, { refusal: null, taskStatus: "CREATED", currentRevision: 1 });
		assert.deepEqual(await controlRepo.decisions.get(decision.id), before);
	});

	test("not_allowed_in_state: approve while the task is not awaiting approval", async () => {
		assert.equal(await refusalOf((await seedDecision("approve", { revisionNumber: 1 })).id), "not_allowed_in_state");
	});

	test("revision_stale: a revision other than the task's current one", async () => {
		assert.equal(await refusalOf((await seedDecision("revise_requirements", { revisionNumber: 999 })).id), "revision_stale");
		assert.equal(await refusalOf((await seedDecision("revise_requirements", { revisionNumber: 1 })).id), null);
	});

	test("actor_not_allowed: a disabled owner", async () => {
		assert.equal(await refusalOf((await seedDecision("pause", { actorId: disabledOwner })).id), "actor_not_allowed");
	});

	test("already_resolved: a decision that has an outcome", async () => {
		const decision = await seedDecision("pause");
		await RecordDecisionOutcome(controlRepo, { decisionId: decision.id, outcome: "applied" });
		assert.equal(await refusalOf(decision.id), "already_resolved");
	});

	test("an unknown decision fails with DecisionNotFoundError", async () => {
		await assert.rejects(ReadDecision(controlRepo, { decisionId: ids(9998) }), DecisionNotFoundError);
	});
});

// The remaining codes need task states and an engineer run that the bench database cannot reach without the workflow;
// the check order is exercised against the handler's inputs through a stub repo.
describe("ReadDecision refusals (stub rows)", () => {
	type Row = Record<string, unknown>;
	const stub = (decision: Row, task: Row | undefined, ownerActive = true) => ({
		decisions: { get: async () => ({ id: "d", taskId: "t", deliveryState: "recorded", actorId: "o", revisionNumber: 1, payload: {}, ...decision }) },
		tasks: { get: async () => (task === undefined ? undefined : { status: "BLOCKED", currentRevision: 1, blockKind: "execution", blockHandler: "owner", ...task }) },
		owners: { activeById: async () => (ownerActive ? {} : undefined) },
	}) as unknown as Parameters<typeof ReadDecision>[0];
	const run = async (repo: Parameters<typeof ReadDecision>[0]) => (await ReadDecision(repo, { decisionId: "d" })).refusal;

	test("block_kind_mismatch: a choice of another kind than the block's", async () => {
		assert.equal(await run(stub({ kind: "resolve_block", payload: { block_kind: "usage_limit" } }, {})), "block_kind_mismatch");
		assert.equal(await run(stub({ kind: "resolve_block", payload: { block_kind: "execution" } }, {})), null);
	});

	test("block_handled: the chief engineer after the owner took the block; allowed while it handles it", async () => {
		assert.equal(await run(stub({ kind: "resolve_block", actorId: null }, { blockHandler: "owner" })), "block_handled");
		assert.equal(await run(stub({ kind: "resolve_block", actorId: null }, { blockHandler: "chief_engineer" })), null);
	});

	test("actor_not_allowed: an engineer deciding anything but resolve_block", async () => {
		assert.equal(await run(stub({ kind: "approve", actorId: null }, { status: "AWAITING_APPROVAL" })), "actor_not_allowed");
	});

	test("task_closed: a final task and a task that is gone", async () => {
		assert.equal(await run(stub({ kind: "pause" }, { status: "CANCELLED" })), "task_closed");
		assert.equal(await run(stub({ kind: "pause" }, undefined)), "task_closed");
	});

	test("not_allowed_in_state: PAUSED allows only resume, cancel, add_feedback, revise_requirements", async () => {
		assert.equal(await run(stub({ kind: "pause" }, { status: "PAUSED" })), "not_allowed_in_state");
		assert.equal(await run(stub({ kind: "resume" }, { status: "PAUSED" })), null);
		assert.equal(await run(stub({ kind: "resolve_block" }, { status: "RUNNING" })), "not_allowed_in_state");
	});

	test("every refusal code is a code the handler can name", () => {
		const named: RefusalCode[] = ["not_allowed_in_state", "revision_stale", "actor_not_allowed", "already_resolved", "block_kind_mismatch", "block_handled", "task_closed"];
		assert.deepEqual([...refusalCodes], named);
	});
});

describe("local activities on the temporal bench", () => {
	let env: TestWorkflowEnvironment;
	before(async () => {
		env = await startTimeSkipping();
	});
	after(async () => {
		await env?.teardown();
	});

	test("a workflow calls ReadDecision through proxyLocalActivities with the timeout of act.ReadDecision.S", async () => {
		// The settings act.<Name>.* are not seeded by a migration (the catalog has no defaults), so the test sets them: 7 s
		// is arbitrary for an in-memory bench; the workflow only needs a positive bound.
		for (const key of allTimeoutKeys()) await migratorRepo.settings.set(key, 7, owner);
		const catalog = createActivityCatalog(await controlRepo.settings.snapshot(allTimeoutKeys()));
		const decision = await seedDecision("revise_requirements", { revisionNumber: 999 });
		const result = await withWorker(
			{ env, taskQueue: "control-activities", workflowsPath: workflowsPathOf(new URL("./temporal/read-decision-workflow.ts", import.meta.url).href), activities: createControlActivities(controlRepo) },
			() => env.client.workflow.execute("ReadDecisionWorkflow", { taskQueue: "control-activities", workflowId: "read-decision-bench", args: [{ decisionId: decision.id, startToCloseSeconds: catalog.timeouts("ReadDecision").S }] }),
		);
		assert.equal(result.decisionId, decision.id);
		assert.equal(result.refusal, "revision_stale");
	});
});

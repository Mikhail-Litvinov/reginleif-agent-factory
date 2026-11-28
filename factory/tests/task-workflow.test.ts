// TaskWorkflow on the time-skipping bench (package 54): the 12 Updates through the matrix, the 7 refusal codes, the decision
// dedup (D23) inside a run and across Continue-As-New, the validator's task_closed, and D28 (no activity task on `control`).
// Activities are stubs that record their calls; the workflow is the production bundle (workflows/index.ts).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { WorkflowUpdateFailedError, type WorkflowHandle } from "@temporalio/client";
import { ApplicationFailure } from "@temporalio/common";
import { Worker } from "@temporalio/worker";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { CONTROL_QUEUE, taskWorkflowId } from "../control/workflow-client.ts";
import { stateQuery } from "../workflows/task.ts";
import { UPDATE_KINDS, type TaskState, type TaskStatus, type UpdateKind } from "../workflows/task-state.ts";
import { startTimeSkipping } from "./temporal/bench.ts";
import {
	HISTORY_MAX_EVENTS_KEY, TASK_CLOSED, activityTaskQueues, controlBundle, makeStub, sendUpdate, startTask, stubSettings, updateWithStart, type StubDecision,
} from "./temporal/task-stub.ts";

const decisions: Record<string, StubDecision> = {};
const stub = makeStub(decisions);
let env: TestWorkflowEnvironment | undefined;
let worker: Worker | undefined;
let running: Promise<void> | undefined;

before(async () => {
	env = await startTimeSkipping();
	worker = await Worker.create({
		connection: env.nativeConnection, taskQueue: CONTROL_QUEUE, workflowBundle: await controlBundle(),
		activities: stub.activities, enableNonLocalActivities: false,
	});
	running = worker.run();
});
after(async () => {
	worker?.shutdown();
	await running;
	await env?.teardown();
});

const client = () => (env as TestWorkflowEnvironment).client;
type Handle = WorkflowHandle;

/** Registers a decision of the given kind for a task and returns its id (the Update id, D23). */
const decide = (kind: UpdateKind, taskId: string, extra: Partial<Omit<StubDecision, "kind" | "taskId">> = {}): string => {
	const id = randomUUID();
	decisions[id] = { kind, taskId, ...extra };
	return id;
};
const stateOf = (handle: Handle): Promise<TaskState> => handle.query<TaskState>(stateQuery);
const eventsOf = (decisionId: string) => stub.calls.events.filter((event) => event.correlationId === decisionId);
const outcomesOf = (decisionId: string) => stub.calls.outcomes.filter((outcome) => outcome.decisionId === decisionId);
const failureTypeOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
	try {
		await promise;
	} catch (error) {
		assert.ok(error instanceof WorkflowUpdateFailedError, `unexpected error ${String(error)}`);
		assert.ok(error.cause instanceof ApplicationFailure, "the Update failure carries an ApplicationFailure");
		return error.cause.type ?? undefined;
	}
	return assert.fail("the Update was expected to fail");
};

describe("TaskWorkflow: the 12 Updates through the matrix", () => {
	interface Case {
		readonly kind: UpdateKind;
		readonly carried: Partial<TaskState>;
		readonly extra?: Partial<Omit<StubDecision, "kind" | "taskId">>;
		readonly expect: Partial<TaskState>;
	}
	const at = (status: TaskStatus, more: Partial<TaskState> = {}): Partial<TaskState> => ({ status, ...more });
	const cases: Case[] = [
		{ kind: "approve", carried: at("AWAITING_APPROVAL"), extra: { revisionNumber: 1 }, expect: at("ACCEPTED") },
		{ kind: "reject", carried: at("AWAITING_APPROVAL"), extra: { revisionNumber: 1 }, expect: at("REJECTED") },
		{ kind: "request_changes", carried: at("AWAITING_APPROVAL"), extra: { revisionNumber: 1 }, expect: at("REWORK_REQUIRED") },
		{ kind: "cancel", carried: at("PLANNING"), expect: at("CANCELLED") },
		{ kind: "cancel", carried: at("RUNNING", { executionId: "e1" }), expect: at("CANCELLING", { stopping: true, afterStop: "CANCELLED" }) },
		{ kind: "pause", carried: at("ASSIGNED"), expect: at("PAUSED", { resumeTo: "ASSIGNED" }) },
		{ kind: "pause", carried: at("RUNNING", { executionId: "e1" }), expect: at("RUNNING", { pauseRequested: true }) },
		{ kind: "resume", carried: at("PAUSED", { resumeTo: "ASSIGNED" }), expect: at("ASSIGNED", { resumeTo: null }) },
		{ kind: "resume", carried: at("RUNNING", { executionId: "e1", pauseRequested: true }), expect: at("RUNNING", { pauseRequested: false }) },
		{ kind: "revise_requirements", carried: at("CREATED"), extra: { revisionNumber: 1 }, expect: at("PLANNING", { revision: 2 }) },
		{ kind: "add_feedback", carried: at("RUNNING", { executionId: "e1" }), expect: at("RUNNING") },
		{ kind: "change_priority", carried: at("ASSIGNED"), extra: { payload: { priority: 5 } }, expect: at("ASSIGNED", { priority: 5 }) },
		{
			kind: "resolve_block", extra: { actorId: null, revisionNumber: 1 },
			carried: at("BLOCKED", { blockKind: "dependency", blockHandler: "chief_engineer", blockReason: "waiting" }),
			expect: at("READY", { blockKind: null, blockHandler: null }),
		},
		{ kind: "force_close", carried: at("CANCELLING", { stopping: true, afterStop: "CANCELLED" }), expect: at("CANCELLED", { endUnconfirmed: true }) },
		{ kind: "allow_agent", carried: at("ASSIGNED"), extra: { payload: { agent_id: "agent-7" } }, expect: at("ASSIGNED", { allowedAgents: ["agent-7"], reselectAgent: true }) },
	];

	it("the cases cover every kind of Update", () => {
		assert.deepEqual([...new Set(cases.map((c) => c.kind))].sort(), [...UPDATE_KINDS].sort());
	});

	for (const c of cases) {
		it(`${c.kind} in ${c.carried.status}: applied, state ${c.expect.status}`, async () => {
			const { taskId, handle } = await startTask(client(), c.carried);
			const decisionId = decide(c.kind, taskId, c.extra);
			const outcome = await sendUpdate(handle, c.kind, decisionId);
			assert.deepEqual(outcome, { outcome: "applied", refusal: null, status: c.expect.status });
			const state = await stateOf(handle);
			for (const [key, value] of Object.entries(c.expect)) assert.deepEqual(state[key as keyof TaskState], value, `state.${key}`);
			assert.equal(state.handled[decisionId]?.outcome, "applied");
			// One event and one outcome, keyed by the decision (the PG unique keys make a replay a no-op).
			const events = eventsOf(decisionId);
			assert.equal(events.length, 1);
			assert.equal(events[0]?.eventType, `decision_${c.kind}`);
			assert.equal(events[0]?.dedupeKey, `decision:${decisionId}`);
			assert.equal(events[0]?.actorType, c.extra?.actorId === null ? "system" : "owner");
			assert.deepEqual(outcomesOf(decisionId), [{ decisionId, outcome: "applied" }]);
		});
	}
});

describe("TaskWorkflow: refusal codes", () => {
	interface Case {
		readonly code: string;
		readonly kind: UpdateKind;
		readonly carried: Partial<TaskState>;
		readonly extra?: Partial<Omit<StubDecision, "kind" | "taskId">>;
	}
	const cases: Case[] = [
		{ code: "not_allowed_in_state", kind: "approve", carried: { status: "CREATED" } },
		{ code: "not_allowed_in_state", kind: "resume", carried: { status: "ASSIGNED" } },
		{ code: "revision_stale", kind: "revise_requirements", carried: { status: "CREATED", revision: 3 }, extra: { revisionNumber: 2 } },
		{ code: "actor_not_allowed", kind: "pause", carried: { status: "ASSIGNED" }, extra: { actorId: null } },
		{ code: "already_resolved", kind: "cancel", carried: { status: "PLANNING" }, extra: { refusal: "already_resolved" } },
		{
			code: "block_kind_mismatch", kind: "resolve_block", extra: { actorId: null, revisionNumber: 1, payload: { block_kind: "scope" } },
			carried: { status: "BLOCKED", blockKind: "dependency", blockHandler: "chief_engineer", blockReason: "waiting" },
		},
		{
			code: "block_handled", kind: "resolve_block", extra: { actorId: null, revisionNumber: 1 },
			carried: { status: "BLOCKED", blockKind: "scope", blockHandler: "owner", blockReason: "scope unclear" },
		},
		// A payload the cell cannot apply is refused, never applied tolerantly (the cell is `prio` before RUNNING, `prioLater` after).
		{ code: "invalid_payload", kind: "change_priority", carried: { status: "ASSIGNED" }, extra: { payload: {} } },
		{ code: "invalid_payload", kind: "change_priority", carried: { status: "ASSIGNED" }, extra: { payload: { priority: "5" } } },
		{ code: "invalid_payload", kind: "change_priority", carried: { status: "RUNNING", executionId: "e1" }, extra: { payload: { priority: null } } },
		{ code: "invalid_payload", kind: "allow_agent", carried: { status: "ASSIGNED" }, extra: { payload: {} } },
		{ code: "invalid_payload", kind: "allow_agent", carried: { status: "ASSIGNED" }, extra: { payload: { agent_id: "" } } },
		{ code: "invalid_payload", kind: "allow_agent", carried: { status: "ASSIGNED" }, extra: { payload: { agent_id: 3 } } },
	];

	it("the cases name every code the workflow can find, task_closed is the validator's (next test)", () => {
		assert.deepEqual([...new Set(cases.map((c) => c.code))].sort(), ["actor_not_allowed", "already_resolved", "block_handled", "block_kind_mismatch", "invalid_payload", "not_allowed_in_state", "revision_stale"]);
	});

	for (const c of cases) {
		it(`${c.code}: ${c.kind} in ${c.carried.status}`, async () => {
			const { taskId, handle } = await startTask(client(), c.carried);
			const before = await stateOf(handle);
			const decisionId = decide(c.kind, taskId, c.extra);
			const outcome = await sendUpdate(handle, c.kind, decisionId);
			assert.deepEqual(outcome, { outcome: "refused", refusal: c.code, status: c.carried.status });
			assert.deepEqual(outcomesOf(decisionId), [{ decisionId, outcome: "refused", refusalReason: c.code }]);
			assert.equal(eventsOf(decisionId).length, 0, "a refusal writes no task event");
			const after = await stateOf(handle);
			assert.deepEqual({ ...after, handled: {} }, { ...before, handled: {} }, "a refusal changes nothing but the handled map");
			assert.deepEqual(after.handled[decisionId], outcome);
		});
	}

	it("task_closed: a closed task refuses an unseen decision in the validator, and nothing is written", async () => {
		const taskId = randomUUID();
		const decisionId = decide("pause", taskId);
		const reads = stub.calls.reads.length;
		const outcomes = stub.calls.outcomes.length;
		assert.equal(await failureTypeOf(updateWithStart(client(), taskId, { status: "CANCELLED" }, "pause", decisionId)), TASK_CLOSED);
		assert.equal(stub.calls.reads.length, reads, "the validator runs no activity");
		assert.equal(stub.calls.outcomes.length, outcomes, "the relay owns the task_closed outcome: the workflow writes none");
	});

	it("a decision the row does not match fails the Update (DecisionKindMismatch) and writes no outcome", async () => {
		const { taskId, handle } = await startTask(client(), { status: "ASSIGNED" });
		const decisionId = decide("cancel", taskId);
		assert.equal(await failureTypeOf(sendUpdate(handle, "pause", decisionId)), "DecisionKindMismatch");
		const otherTask = decide("pause", randomUUID());
		assert.equal(await failureTypeOf(sendUpdate(handle, "pause", otherTask)), "DecisionKindMismatch");
		assert.equal(outcomesOf(decisionId).length + outcomesOf(otherTask).length, 0);
		assert.equal((await stateOf(handle)).status, "ASSIGNED");
	});

	it("an unknown decision fails the Update with the activity's non-retryable type, not a hang", async () => {
		const { handle } = await startTask(client(), { status: "ASSIGNED" });
		assert.equal(await failureTypeOf(sendUpdate(handle, "pause", randomUUID())), "DecisionNotFoundError");
	});

	it("an Update without a decision id is refused by the validator", async () => {
		const { handle } = await startTask(client(), { status: "ASSIGNED" });
		assert.equal(await failureTypeOf(handle.executeUpdate("pause", { updateId: randomUUID(), args: [{ decisionId: "" }] })), "InvalidDecisionUpdate");
	});
});

describe("TaskWorkflow: decision dedup (D23)", () => {
	it("a decision id already in the handled map returns its stored outcome and runs no activity", async () => {
		const stored = { outcome: "applied", refusal: null, status: "PAUSED" } as const;
		const decisionId = randomUUID();
		const { taskId, handle } = await startTask(client(), { status: "PAUSED", resumeTo: "ASSIGNED", handled: { [decisionId]: stored } });
		decisions[decisionId] = { kind: "pause", taskId };
		const reads = stub.calls.reads.length;
		assert.deepEqual(await sendUpdate(handle, "pause", decisionId), stored);
		assert.equal(stub.calls.reads.length, reads);
		assert.equal(eventsOf(decisionId).length, 0);
	});

	it("a closed task still answers a decision it handled before it closed", async () => {
		const stored = { outcome: "applied", refusal: null, status: "CANCELLED" } as const;
		const decisionId = randomUUID();
		const taskId = randomUUID();
		decisions[decisionId] = { kind: "cancel", taskId };
		assert.deepEqual(await updateWithStart(client(), taskId, { status: "CANCELLED", handled: { [decisionId]: stored } }, "cancel", decisionId), stored);
	});

	it("an Update applied before Continue-As-New is not applied again after it", async () => {
		// history.maxEvents 1: the first handled decision already exceeds it, so the run continues as new at once (the smallest bound).
		const settings = stubSettings({ [HISTORY_MAX_EVENTS_KEY]: 1 });
		const { taskId, handle } = await startTask(client(), { status: "ASSIGNED", settings });
		const firstRun = (await handle.describe()).runId;
		const decisionId = decide("add_feedback", taskId);
		const first = await sendUpdate(handle, "add_feedback", decisionId);
		assert.equal(first.outcome, "applied");
		// Wait for the new run without a clock: each describe is one round trip, the bound is a failure, not a timeout.
		const latest = client().workflow.getHandle(taskWorkflowId(taskId));
		let runId = firstRun;
		for (let i = 0; i < 2000 && runId === firstRun; i += 1) runId = (await latest.describe()).runId;
		assert.notEqual(runId, firstRun, "the workflow continued as new");
		const carried = await stateOf(latest);
		assert.deepEqual(carried.handled[decisionId], first, "the handled map crossed Continue-As-New");
		assert.deepEqual(carried.settings, settings, "the settings crossed too: no second LoadSettings");

		// The same decision id again: the server's own Update dedup does not cross runs, the carried map does.
		const reads = stub.calls.reads.length;
		const again = await latest.executeUpdate("add_feedback", { updateId: decisionId, args: [{ decisionId }] });
		assert.deepEqual(again, first);
		assert.equal(stub.calls.reads.length, reads, "no second ReadDecision");
		assert.equal(eventsOf(decisionId).length, 1, "applied exactly once");
		assert.equal(outcomesOf(decisionId).length, 1);
	});

	it("without a bound and without the server's suggestion the run does not continue as new", async () => {
		const { taskId, handle } = await startTask(client(), { status: "ASSIGNED" });
		const firstRun = (await handle.describe()).runId;
		await sendUpdate(handle, "add_feedback", decide("add_feedback", taskId));
		await sendUpdate(handle, "add_feedback", decide("add_feedback", taskId));
		assert.equal((await client().workflow.getHandle(taskWorkflowId(taskId)).describe()).runId, firstRun);
	});
});

describe("TaskWorkflow: local activities only (D28)", () => {
	it("a task that handled decisions has local activity markers in its history and no activity task on any queue", async () => {
		const { taskId, handle } = await startTask(client(), { status: "ASSIGNED" });
		await sendUpdate(handle, "add_feedback", decide("add_feedback", taskId));
		await sendUpdate(handle, "approve", decide("approve", taskId, { revisionNumber: 1 }));
		const history = await handle.fetchHistory();
		const markers = (history.events ?? []).filter((event) => event.markerRecordedEventAttributes?.markerName === "core_local_activity");
		// LoadSettings, then ReadDecision + PersistTaskEvent + RecordDecisionOutcome for the applied one, ReadDecision + RecordDecisionOutcome for the refused one.
		assert.equal(markers.length, 6);
		assert.deepEqual(activityTaskQueues(history), [], `no activity task may reach queue ${CONTROL_QUEUE}`);
	});

	it("the Worker of the bench polls only `control` and takes no non-local activity", () => {
		assert.equal((worker as Worker).options.taskQueue, CONTROL_QUEUE);
		assert.equal((worker as Worker).options.enableNonLocalActivities, false);
	});
});

describe("TaskWorkflow: wake and state", () => {
	it("a wake Signal is accepted by a running task and changes nothing", async () => {
		const { handle } = await startTask(client(), { status: "ASSIGNED" });
		const before = await stateOf(handle);
		await handle.signal("wake");
		assert.deepEqual(await stateOf(handle), before);
	});

	it("a task started with only {taskId} begins in CREATED with revision 1 and loads its settings once", async () => {
		const loads = stub.calls.loads.length;
		const { taskId, handle } = await startTask(client());
		const state = await stateOf(handle);
		assert.equal(state.taskId, taskId);
		assert.equal(state.status, "CREATED");
		assert.equal(state.revision, 1);
		assert.equal(stub.calls.loads.length, loads + 1);
	});
});

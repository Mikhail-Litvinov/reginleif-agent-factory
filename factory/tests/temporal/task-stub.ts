// Bench for the TaskWorkflow tests: stub local activities that record their calls, a workflow bundle made once per file,
// and a Worker on queue `control` (local activities only, D28) that runs the production workflow entry.
import { randomUUID } from "node:crypto";
import { Worker, bundleWorkflowCode, type WorkflowBundleWithSourceMap } from "@temporalio/worker";
import { type TestWorkflowEnvironment } from "@temporalio/testing";
import { WithStartWorkflowOperation, type Client, type WorkflowHandle } from "@temporalio/client";
import type { TaskWorkflow as TaskWorkflowType } from "../../workflows/task.ts";
import { allTimeoutKeys } from "../../control/activity-catalog.ts";
import { LIVENESS_SETTING_KEYS } from "../../control/liveness-settings.ts";
import { CONTROL_WORKFLOWS_PATH } from "../../control/worker.ts";
import { CONTROL_QUEUE, taskWorkflowId } from "../../control/workflow-client.ts";
import type { ReadDecisionResult, PersistTaskEventInput, RecordDecisionOutcomeInput } from "../../control/activities/index.ts";
import { DecisionNotFoundError, TASK_CLOSED } from "../../control/activities/refusal.ts";
import { HISTORY_MAX_EVENTS_KEY } from "../../workflows/task.ts";
import { initialState, type HandledOutcome, type TaskState, type UpdateKind } from "../../workflows/task-state.ts";

/** Every timeout and liveness setting at 7 s (bench values; the stubs never wait, no real time passes; 7 s is below the 10 s workflow task timeout). */
export const stubSettings = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
	...Object.fromEntries([...allTimeoutKeys(), ...LIVENESS_SETTING_KEYS].map((key) => [key, 7])),
	...extra,
});

export interface StubDecision {
	readonly kind: UpdateKind;
	readonly taskId: string;
	readonly actorId?: string | null;
	readonly payload?: unknown;
	readonly revisionNumber?: number | null;
	/** What the row-level checks of the real ReadDecision would say. */
	readonly refusal?: ReadDecisionResult["refusal"];
}

export interface StubCalls {
	readonly reads: string[];
	readonly outcomes: RecordDecisionOutcomeInput[];
	readonly events: PersistTaskEventInput[];
	readonly loads: number[];
}

export interface Stub {
	readonly calls: StubCalls;
	readonly activities: {
		readonly LoadSettings: (input: { keys: readonly string[] }) => Promise<Record<string, unknown>>;
		readonly ReadDecision: (input: { decisionId: string }) => Promise<ReadDecisionResult>;
		readonly RecordDecisionOutcome: (input: RecordDecisionOutcomeInput) => Promise<{ decisionId: string }>;
		readonly PersistTaskEvent: (event: PersistTaskEventInput) => Promise<{ id: string }>;
	};
}

/** Stub activities over a table of decisions; a decision the table lacks fails like the real one (DecisionNotFoundError). */
export const makeStub = (decisions: Record<string, StubDecision>, settings: Record<string, unknown> = stubSettings()): Stub => {
	const calls: StubCalls = { reads: [], outcomes: [], events: [], loads: [] };
	return {
		calls,
		activities: {
			LoadSettings: async (input) => {
				calls.loads.push(input.keys.length);
				return Object.fromEntries(input.keys.filter((key) => key in settings).map((key) => [key, settings[key]]));
			},
			ReadDecision: async ({ decisionId }) => {
				calls.reads.push(decisionId);
				const row = decisions[decisionId];
				if (row === undefined) throw new DecisionNotFoundError(decisionId);
				return {
					decisionId, taskId: row.taskId, kind: row.kind, deliveryState: "pending", taskStatus: null, currentRevision: null,
					actorId: row.actorId === undefined ? "owner-1" : row.actorId, payload: row.payload ?? {}, revisionNumber: row.revisionNumber ?? null,
					refusal: row.refusal ?? null,
				};
			},
			RecordDecisionOutcome: async (input) => {
				calls.outcomes.push(input);
				return { decisionId: input.decisionId };
			},
			PersistTaskEvent: async (event) => {
				calls.events.push(event);
				return { id: event.id };
			},
		},
	};
};

let bundle: Promise<WorkflowBundleWithSourceMap> | undefined;
/** The production workflow entry bundled once per test file process. */
export const controlBundle = (): Promise<WorkflowBundleWithSourceMap> => (bundle ??= bundleWorkflowCode({ workflowsPath: CONTROL_WORKFLOWS_PATH }));

/** Runs `body` while a Worker on queue `control` with the given stub activities polls; the Worker is shut down in every case. */
export const withControlWorker = async <T>(env: TestWorkflowEnvironment, stub: Stub, body: () => Promise<T>): Promise<T> => {
	const worker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue: CONTROL_QUEUE,
		workflowBundle: await controlBundle(),
		activities: stub.activities,
		enableNonLocalActivities: false,
	});
	return worker.runUntil(body());
};

/** Starts a TaskWorkflow, optionally from a carried state (what Continue-As-New hands on), under a fresh task id. */
export const startTask = async (client: Client, carried?: Partial<TaskState>) => {
	const taskId = carried?.taskId ?? randomUUID();
	const input = carried === undefined ? { taskId, decisionsOnly: true } : { taskId, decisionsOnly: true, carried: { ...initialState(taskId), ...carried, taskId } };
	const handle = await client.workflow.start("TaskWorkflow", { taskQueue: CONTROL_QUEUE, workflowId: taskWorkflowId(taskId), args: [input] });
	return { taskId, handle };
};

/** Sends one decision Update; the Update id is the decision id (D23). */
export const sendUpdate = (handle: Awaited<ReturnType<typeof startTask>>["handle"], kind: UpdateKind, decisionId: string): Promise<HandledOutcome> =>
	handle.executeUpdate<HandledOutcome, [{ decisionId: string }]>(kind, { updateId: decisionId, args: [{ decisionId }] });

/** Starts a TaskWorkflow from `carried` and delivers one Update in its first workflow task (the validator sees the carried state). */
export const updateWithStart = (client: Client, taskId: string, carried: Partial<TaskState>, kind: UpdateKind, decisionId: string): Promise<HandledOutcome> =>
	client.workflow.executeUpdateWithStart<typeof TaskWorkflowType, HandledOutcome, [{ decisionId: string }]>(kind, {
		updateId: decisionId,
		args: [{ decisionId }],
		startWorkflowOperation: new WithStartWorkflowOperation("TaskWorkflow", {
			taskQueue: CONTROL_QUEUE, workflowId: taskWorkflowId(taskId), workflowIdConflictPolicy: "USE_EXISTING",
			args: [{ taskId, decisionsOnly: true, carried: { ...initialState(taskId), ...carried, taskId } }],
		}),
	});

/** The events of a history that schedule an activity task (a non-local activity): there must be none, with its queue named. */
export const activityTaskQueues = (history: Awaited<ReturnType<WorkflowHandle["fetchHistory"]>>): string[] =>
	(history.events ?? []).flatMap((event) => event.activityTaskScheduledEventAttributes === undefined || event.activityTaskScheduledEventAttributes === null
		? []
		: [event.activityTaskScheduledEventAttributes.taskQueue?.name ?? ""]);

export { HISTORY_MAX_EVENTS_KEY, TASK_CLOSED };

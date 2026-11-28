// TaskWorkflow, the skeleton of package 54 (temporal.md "TaskWorkflow"): one workflow per task, queue `control`, id `task-<uuid>`,
// start arguments `[{taskId}]`. It owns the in-memory state, answers the 12 decision Updates by the matrix, deduplicates by
// decision id across Continue-As-New (D23) and calls only local activities (D28: no activity task ever reaches the queue).
// The lifecycle itself (planning, runs, verification, the exits of the table) is packages 55 and 56; the system moves they
// will make are in `FORWARD_EXITS` of task-matrix.ts.
//
// Workflow code: imports only `@temporalio/workflow`, types and other workflow modules; no clock, randomness, network or env
// (`uuid4()` of the SDK is deterministic).
import {
	ActivityFailure, ApplicationFailure, allHandlersFinished, condition, continueAsNew, defineQuery, defineSignal, defineUpdate,
	proxyLocalActivities, setHandler, uuid4, workflowInfo,
	type LocalActivityOptions,
} from "@temporalio/workflow";
import type { ControlActivities } from "../control/activities/index.ts";
import { TASK_CLOSED } from "../control/activities/refusal.ts";
import { allTimeoutKeys, createActivityCatalog, type ActivityName } from "../control/activity-catalog.ts";
import { applyCell, memoryRefusal, resolveCell } from "./task-matrix.ts";
import {
	UPDATE_KINDS, isFinal, initialState,
	type DecisionUpdateInput, type HandledOutcome, type TaskState, type TaskWorkflowInput, type UpdateKind,
} from "./task-state.ts";

/** Global settings key: the history length (events) at which the workflow continues as new; absent means only the server's suggestion counts. */
export const HISTORY_MAX_EVENTS_KEY = "history.maxEvents";

// Failure types that retrying cannot cure (the type is the name the activity's error carries over the wire).
const NON_RETRYABLE = ["DecisionNotFoundError", TASK_CLOSED, "UnknownTask"];
const KIND_MISMATCH = "DecisionKindMismatch";

export const wakeSignal = defineSignal("wake");
export const stateQuery = defineQuery<TaskState>("state");

type DecisionActivities = Pick<ControlActivities, "ReadDecision" | "RecordDecisionOutcome" | "PersistTaskEvent">;

export async function TaskWorkflow(input: TaskWorkflowInput): Promise<TaskState> {
	let state: TaskState = input.carried ?? initialState(input.taskId);
	// Decisions handled by this run: Continue-As-New waits for at least one, so a small bound cannot loop on an empty run.
	let handledHere = 0;
	let acts: DecisionActivities | null = null;
	let maxEvents: number | null = null;

	// Registered before the first await: an Update that arrives with the first workflow task finds its handler.
	setHandler(stateQuery, () => state);
	setHandler(wakeSignal, () => { /* the activation itself re-evaluates the main loop's condition */ });

	const bootstrap = async (): Promise<void> => {
		let settings = state.settings;
		if (settings === null) {
			// The bound of the loader cannot come from settings it loads: half the workflow task timeout keeps it below the task.
			const { LoadSettings } = proxyLocalActivities<Pick<ControlActivities, "LoadSettings">>({
				startToCloseTimeout: Math.floor(workflowInfo().taskTimeoutMs / 2), retry: { nonRetryableErrorTypes: NON_RETRYABLE },
			});
			settings = await LoadSettings({ keys: [...allTimeoutKeys(), HISTORY_MAX_EVENTS_KEY] });
			state = { ...state, settings };
		}
		const catalog = createActivityCatalog(settings);
		const optionsOf = (name: ActivityName): LocalActivityOptions => {
			const { S, C } = catalog.timeouts(name);
			return { startToCloseTimeout: Math.round((S ?? 0) * 1000), scheduleToCloseTimeout: Math.round((C ?? 0) * 1000), retry: { nonRetryableErrorTypes: NON_RETRYABLE } };
		};
		// Each proxy is read by name: a proxy has no own keys, so spreading one would copy nothing.
		acts = {
			ReadDecision: proxyLocalActivities<Pick<ControlActivities, "ReadDecision">>(optionsOf("ReadDecision")).ReadDecision,
			RecordDecisionOutcome: proxyLocalActivities<Pick<ControlActivities, "RecordDecisionOutcome">>(optionsOf("RecordDecisionOutcome")).RecordDecisionOutcome,
			PersistTaskEvent: proxyLocalActivities<Pick<ControlActivities, "PersistTaskEvent">>(optionsOf("PersistTaskEvent")).PersistTaskEvent,
		};
		const bound = settings[HISTORY_MAX_EVENTS_KEY];
		maxEvents = typeof bound === "number" && Number.isFinite(bound) && bound > 0 ? bound : null;
	};
	const ready = bootstrap();
	ready.catch(() => { /* the main loop awaits `ready` and surfaces the failure; this keeps the rejection handled meanwhile */ });

	// One decision at a time: the matrix reads and changes one state, and the activities it awaits must not interleave.
	let tail: Promise<unknown> = Promise.resolve();
	const exclusive = <T>(body: () => Promise<T>): Promise<T> => {
		const run = tail.then(body, body);
		tail = run.catch(() => undefined);
		return run;
	};

	// An activity failure becomes a failure of the Update alone (a plain error would fail the workflow task and loop).
	const asUpdateFailure = (error: unknown): never => {
		if (error instanceof ActivityFailure) {
			const cause = error.cause;
			if (cause instanceof ApplicationFailure) throw ApplicationFailure.nonRetryable(cause.message, cause.type ?? "ActivityFailed");
			throw ApplicationFailure.nonRetryable(error.message, "ActivityFailed");
		}
		throw error;
	};

	const handle = (kind: UpdateKind, { decisionId }: DecisionUpdateInput): Promise<HandledOutcome> => {
		const stored = state.handled[decisionId];
		if (stored !== undefined) return Promise.resolve(stored);
		return exclusive(async (): Promise<HandledOutcome> => {
			// A repeat that waited for the lock finds the first run's outcome (the validator cannot see it yet).
			const again = state.handled[decisionId];
			if (again !== undefined) return again;
			await ready;
			const { ReadDecision, RecordDecisionOutcome, PersistTaskEvent } = acts as DecisionActivities;
			try {
				const read = await ReadDecision({ decisionId });
				if (read.kind !== kind || read.taskId !== state.taskId) throw ApplicationFailure.nonRetryable(`decision ${decisionId} is not a ${kind} of task ${state.taskId}`, KIND_MISMATCH);
				const refusal = read.refusal ?? memoryRefusal(state, kind, read);
				const cell = resolveCell(state, kind);
				let outcome: HandledOutcome;
				let next: TaskState = state;
				if (refusal !== null || cell === "R" || cell === "X") {
					outcome = { outcome: "refused", refusal: refusal ?? "not_allowed_in_state", status: state.status };
					await RecordDecisionOutcome({ decisionId, outcome: "refused", refusalReason: outcome.refusal as string });
				} else {
					const applied = applyCell(state, kind, cell, read.payload);
					next = applied.state;
					outcome = { outcome: "applied", refusal: null, status: next.status };
					await PersistTaskEvent({
						id: uuid4(), taskId: state.taskId, runId: null, eventType: `decision_${kind}`,
						actorType: read.actorId === null ? "system" : "owner", actorId: read.actorId,
						payload: { decisionId, kind, from: state.status, to: next.status, effect: applied.effect, revision: next.revision },
						correlationId: decisionId, dedupeKey: `decision:${decisionId}`,
					});
					await RecordDecisionOutcome({ decisionId, outcome: "applied" });
				}
				// The in-memory change is committed only after both writes: a failure above leaves the decision pending and retryable.
				state = { ...next, handled: { ...next.handled, [decisionId]: outcome } };
				handledHere += 1;
				return outcome;
			} catch (error) {
				return asUpdateFailure(error);
			}
		});
	};

	for (const kind of UPDATE_KINDS) {
		setHandler(defineUpdate<HandledOutcome, [DecisionUpdateInput]>(kind), (args) => handle(kind, args), {
			// Form only: no activity may run in a validator. A closed task is told here only to an id it never handled.
			validator: (args) => {
				if (typeof args?.decisionId !== "string" || args.decisionId === "") throw ApplicationFailure.nonRetryable("an Update carries {decisionId}", "InvalidDecisionUpdate");
				if (isFinal(state.status) && state.handled[args.decisionId] === undefined) throw ApplicationFailure.nonRetryable(`task ${state.taskId} is ${state.status}`, TASK_CLOSED);
			},
		});
	}

	await ready;

	// Continue-As-New is due on the server's suggestion or at the settings bound, and happens only at a quiet point.
	const due = (): boolean => handledHere > 0 && (workflowInfo().continueAsNewSuggested || (maxEvents !== null && workflowInfo().historyLength >= maxEvents));
	await condition(() => isFinal(state.status) || (due() && allHandlersFinished()));
	if (isFinal(state.status)) {
		await condition(allHandlersFinished);
		return state;
	}
	return continueAsNew<typeof TaskWorkflow>({ taskId: state.taskId, carried: state });
}

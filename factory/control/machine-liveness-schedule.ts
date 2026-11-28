// The Temporal Schedule `machine-liveness` (package 57, temporal.md "Schedules"): one MachineLivenessWorkflow run per tick.
// The interval is `liveness.intervalSeconds`; the workflow's local activity timeout is `act.MachineLiveness.S`. Overlap is
// SKIP: a tick that comes while the previous pass still runs is dropped, the next tick evaluates the workers again.
import { ScheduleAlreadyRunning, ScheduleOverlapPolicy, type Client } from "@temporalio/client";
import { createActivityCatalog } from "./activity-catalog.ts";
import { CONTROL_QUEUE } from "./workflow-client.ts";
import { LIVENESS_INTERVAL_KEY, livenessSettingsProblems } from "./liveness-settings.ts";
import type { MachineLivenessWorkflowInput } from "../workflows/machine-liveness.ts";

export const MACHINE_LIVENESS_SCHEDULE_ID = "machine-liveness";

/** Workflow id prefix of the scheduled runs; the server adds a per-run suffix to it. */
const WORKFLOW_ID_PREFIX = "machine-liveness";

export interface MachineLivenessScheduleSpec {
	readonly intervalMs: number;
	readonly input: MachineLivenessWorkflowInput;
}

/**
 * Reads the schedule's spec from a settings snapshot. Throws on an absent or non-positive liveness setting, or on a missing
 * `act.MachineLiveness.S` (the same rule as the Control Worker start check: no default is invented).
 */
export const machineLivenessScheduleSpec = (snapshot: Readonly<Record<string, unknown>>): MachineLivenessScheduleSpec => {
	const problems = livenessSettingsProblems(snapshot);
	if (problems.length > 0) throw new Error(`machine-liveness schedule refused: ${problems.join("; ")}`);
	const startToCloseSeconds = createActivityCatalog(snapshot).timeouts("MachineLiveness").S;
	if (startToCloseSeconds === undefined) throw new Error("machine-liveness schedule refused: MachineLiveness has no S timeout");
	return {
		intervalMs: Number(snapshot[LIVENESS_INTERVAL_KEY]) * 1000,
		input: { startToCloseSeconds },
	};
};

/** Creates the Schedule, or updates it in place when it already exists, so a changed setting takes effect at the next tick. */
export const ensureMachineLivenessSchedule = async (client: Client, snapshot: Readonly<Record<string, unknown>>): Promise<void> => {
	const { intervalMs, input } = machineLivenessScheduleSpec(snapshot);
	const action = {
		type: "startWorkflow" as const,
		workflowType: "MachineLivenessWorkflow",
		workflowId: WORKFLOW_ID_PREFIX,
		taskQueue: CONTROL_QUEUE,
		args: [input],
	};
	const spec = { intervals: [{ every: intervalMs }] };
	try {
		await client.schedule.create({
			scheduleId: MACHINE_LIVENESS_SCHEDULE_ID,
			spec,
			action,
			policies: { overlap: ScheduleOverlapPolicy.SKIP },
		});
	} catch (error) {
		if (!(error instanceof ScheduleAlreadyRunning)) throw error;
		await client.schedule.getHandle(MACHINE_LIVENESS_SCHEDULE_ID).update((previous) => ({
			action,
			spec,
			policies: { ...previous.policies, overlap: ScheduleOverlapPolicy.SKIP },
			state: { paused: previous.state.paused, note: previous.state.note },
		}));
	}
};

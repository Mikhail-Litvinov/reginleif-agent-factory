// MachineLivenessWorkflow (package 57, temporal.md "Schedules"): one pass per tick of the Schedule `machine-liveness`, on the
// Control queue. It runs one local activity, MachineLiveness, which decides OFFLINE and ONLINE for every worker row and writes
// the `worker_offline` notices. The clock is the workflow's Date (the SDK patches it to workflow time), so the activity reads no clock of its own.
//
// Workflow code: imports only `@temporalio/workflow` and types; no clock, randomness, network or env (`new Date()` reads the workflow clock, which is deterministic).
import { proxyLocalActivities } from "@temporalio/workflow";
import type { ControlActivities } from "../control/activities/index.ts";
import { CONTRACT_VERSION } from "./task-state.ts";

export interface MachineLivenessWorkflowInput {
	/** Start-to-close of the MachineLiveness activity in seconds: the setting `act.MachineLiveness.S`, read when the Schedule is set. */
	readonly startToCloseSeconds: number;
}

export async function MachineLivenessWorkflow(input: MachineLivenessWorkflowInput) {
	// One attempt: a failed pass is retried by the next tick of the Schedule, not by a retry loop inside this run.
	const { MachineLiveness } = proxyLocalActivities<Pick<ControlActivities, "MachineLiveness">>({
		startToCloseTimeout: `${input.startToCloseSeconds} seconds`,
		retry: { maximumAttempts: 1 },
	});
	return MachineLiveness({ now: new Date().toISOString(), contractVersion: CONTRACT_VERSION });
}

// Bench workflow that calls ReadDecision as a local activity (D28). Type-only import: the bundle must not pull node code in.
import { proxyLocalActivities } from "@temporalio/workflow";
import type { ControlActivities } from "../../control/activities/index.ts";
import type { ReadDecisionResult } from "../../control/activities/read-decision.ts";

export async function ReadDecisionWorkflow(input: { readonly decisionId: string; readonly startToCloseSeconds: number }): Promise<ReadDecisionResult> {
	// The bound comes from settings act.ReadDecision.S, read by the caller through the ActivityCatalog.
	const { ReadDecision } = proxyLocalActivities<Pick<ControlActivities, "ReadDecision">>({ startToCloseTimeout: `${input.startToCloseSeconds} seconds` });
	return ReadDecision({ decisionId: input.decisionId });
}

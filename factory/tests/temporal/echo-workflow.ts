// Minimal workflow of the test bench. Type-only import of the activities (the bundle must not pull node code in),
// a local activity only (D28), and the PatchGate module of workflows/ imported with a .ts extension, so the bundle
// check covers the same import style the lanes use.
import { proxyLocalActivities } from "@temporalio/workflow";
import { patchGate } from "../../workflows/patch-gate.ts";
import type { EchoActivities } from "./echo-activities.ts";

// 5 seconds: arbitrary for a fake activity that returns at once; the real bound comes from settings act.<Name>.S.
const { Echo } = proxyLocalActivities<EchoActivities>({ startToCloseTimeout: "5 seconds" });

export async function EchoWorkflow(input: { readonly text: string }): Promise<{ readonly echoed: string; readonly patched: boolean }> {
	const patched = patchGate.isNew("bench-patch");
	return { echoed: await Echo(input.text), patched };
}

// Workflow of the proxy test (package 49): it schedules its step as an ordinary activity (proxyActivities), the one kind of
// step that travels to a worker through the TLS proxy. The factory's own workflows never do this (D28: server steps are local
// activities), the test uses it to prove that a worker with its certificate can poll and complete an activity task.
import { proxyActivities } from "@temporalio/workflow";
import type { EchoActivities } from "./echo-activities.ts";

// 30 seconds: arbitrary for a fake activity that returns at once; it bounds a test that would otherwise wait for a dead worker.
const { Echo } = proxyActivities<EchoActivities>({ startToCloseTimeout: "30 seconds" });

export async function RemoteEchoWorkflow(input: { readonly text: string }): Promise<{ readonly echoed: string }> {
	return { echoed: await Echo(input.text) };
}

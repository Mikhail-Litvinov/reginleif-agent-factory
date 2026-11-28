import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { startTimeSkipping, withWorker, workflowsPathOf } from "./temporal/bench.ts";
import { echoActivities } from "./temporal/echo-activities.ts";
import { ACTIVITIES, allTimeoutKeys, createActivityCatalog } from "../control/activity-catalog.ts";

describe("temporal bench", () => {
	let env: TestWorkflowEnvironment;
	before(async () => {
		env = await startTimeSkipping();
	});
	after(async () => {
		await env?.teardown();
	});

	it("runs a workflow through a local activity and the PatchGate in the time-skipping environment", async () => {
		const result = await withWorker(
			{ env, taskQueue: "bench", workflowsPath: workflowsPathOf(new URL("./temporal/echo-workflow.ts", import.meta.url).href), activities: echoActivities },
			() => env.client.workflow.execute("EchoWorkflow", { taskQueue: "bench", workflowId: "bench-echo", args: [{ text: "hi" }] }),
		);
		assert.deepEqual(result, { echoed: "echo:hi", patched: true });
	});
});

describe("activity catalog", () => {
	const snapshot = Object.fromEntries(allTimeoutKeys().map((key) => [key, 7]));

	it("reads one timeout per kind of each row from settings act.<Name>.<kind>", () => {
		const catalog = createActivityCatalog(snapshot);
		assert.deepEqual(catalog.timeouts("MonitorExecution"), { S: 7, Q: 7, H: 7 });
		assert.deepEqual(catalog.timeouts("LoadSettings"), { S: 7 });
		assert.equal(allTimeoutKeys().length, Object.values(ACTIVITIES).reduce((n, def) => n + def.kinds.length, 0));
	});

	it("routes machine activities to their queue and gives local ones none", () => {
		const catalog = createActivityCatalog(snapshot);
		assert.equal(catalog.queue("PrepareTask", "m1"), undefined);
		assert.equal(catalog.queue("StartAgentExecution", "m1"), "machine-m1");
		assert.equal(catalog.queue("RunGpuJob", "m1"), "machine-m1-gpu");
		assert.ok(catalog.localNames().includes("RecordPrecedent"));
	});

	it("refuses a missing or non-positive setting", () => {
		const catalog = createActivityCatalog({ ...snapshot, "act.PrepareTask.S": 0 });
		assert.throws(() => catalog.timeouts("PrepareTask"), /act\.PrepareTask\.S/);
		assert.throws(() => createActivityCatalog({}).timeouts("ReadDecision"), /act\.ReadDecision\.S/);
	});
});

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { startTimeSkipping } from "./temporal/bench.ts";
import type { SettingsReader } from "../db/repo/settings.ts";
import { MACHINE_LIVENESS_SCHEDULE_ID } from "../control/machine-liveness-schedule.ts";
import { LIVENESS_INTERVAL_KEY, LIVENESS_SILENCE_KEY } from "../control/liveness-settings.ts";
import { createControlWorker } from "../control/worker.ts";
import type { ControlActivities } from "../control/activities/index.ts";
import { makeStub, stubSettings } from "./temporal/task-stub.ts";

// Bench value, injected here: the product has no default for the liveness settings. The silence is not under test here.
const BENCH_SILENCE_SECONDS = 60;

const readerOf = (snapshot: Record<string, unknown>): SettingsReader => ({ snapshot: async (keys) => Object.fromEntries(keys.filter((key) => key in snapshot).map((key) => [key, snapshot[key]])) }) as SettingsReader;

let env: TestWorkflowEnvironment;

/** Starts the Control Worker once with the given liveness interval, as the production startup does, and stops it again. */
const startControlWorker = async (intervalSeconds: number): Promise<void> => {
	const settings = stubSettings({ [LIVENESS_INTERVAL_KEY]: intervalSeconds, [LIVENESS_SILENCE_KEY]: BENCH_SILENCE_SECONDS });
	const worker = await createControlWorker({
		connection: env.nativeConnection, client: env.client, settings: readerOf(settings), activities: makeStub({}).activities as unknown as ControlActivities,
	});
	// A created Worker holds the connection until it has run and shut down: run it once, then it stops.
	await worker.runUntil(Promise.resolve());
};

/**
 * The interval of the one Schedule, in milliseconds. A Schedule id is unique in the namespace (a second create fails with
 * ScheduleAlreadyRunning), so reading the id is reading the single Schedule. The time-skipping test server does not
 * implement ListSchedules, so the count is not taken from a list.
 */
const scheduledEveryMs = async (): Promise<number> => {
	const description = await env.client.schedule.getHandle(MACHINE_LIVENESS_SCHEDULE_ID).describe();
	return Number(description.spec.intervals?.[0]?.every);
};

describe("machine-liveness Schedule, created by the Control Worker startup", () => {
	before(async () => { env = await startTimeSkipping(); });
	after(async () => { await env.teardown(); });

	it("two starts leave one Schedule at the current interval, and its runs use the workflowId the Schedule reports", async () => {
		await startControlWorker(30);
		await startControlWorker(30);
		assert.equal(await scheduledEveryMs(), 30_000);

		// Time skipping: one interval passes, the server starts a run. Its workflowId is read from the Schedule, not assumed.
		await env.sleep(31_000);
		const description = await env.client.schedule.getHandle(MACHINE_LIVENESS_SCHEDULE_ID).describe();
		const runIds = description.info.recentActions.map((result) => result.action.workflow.workflowId);
		assert.ok(runIds.length >= 1, "the Schedule started at least one run");
		for (const workflowId of runIds) {
			assert.ok(workflowId.startsWith(MACHINE_LIVENESS_SCHEDULE_ID), `${workflowId} starts with the Schedule id`);
			const run = await env.client.workflow.getHandle(workflowId).describe();
			assert.equal(run.type, "MachineLivenessWorkflow");
			assert.equal(run.taskQueue, "control");
		}
	});

	it("starting with a changed interval updates the same Schedule in place", async () => {
		await startControlWorker(45);
		assert.equal(await scheduledEveryMs(), 45_000);
	});
});

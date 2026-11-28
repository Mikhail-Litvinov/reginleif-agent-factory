// ensureMachineLivenessSchedule against an in-memory fake of the Schedule API. The time-skipping test server does not implement
// ListSchedules or DescribeSchedule, so the interval and the Schedule count are checked here; the wiring into the Control Worker
// start is checked by machine-liveness-schedule.test.ts against the real server.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ScheduleAlreadyRunning, type Client } from "@temporalio/client";
import { ensureMachineLivenessSchedule, MACHINE_LIVENESS_SCHEDULE_ID } from "../control/machine-liveness-schedule.ts";
import { CONTROL_QUEUE } from "../control/workflow-client.ts";
import { LIVENESS_INTERVAL_KEY, LIVENESS_SILENCE_KEY } from "../control/liveness-settings.ts";

interface StoredSchedule {
	spec: { intervals: { every: number }[] };
	action: { workflowId: string; taskQueue: string; workflowType: string; args: unknown[] };
	policies: { overlap: string };
	state: { paused: boolean; note?: string };
}

// The fake keeps one entry per schedule id, like the server: create of an existing id throws ScheduleAlreadyRunning.
const makeFakeClient = () => {
	const schedules = new Map<string, StoredSchedule>();
	const client = {
		schedule: {
			create: async (options: { scheduleId: string; spec: StoredSchedule["spec"]; action: StoredSchedule["action"]; policies: StoredSchedule["policies"] }) => {
				if (schedules.has(options.scheduleId)) throw new ScheduleAlreadyRunning("already running", options.scheduleId);
				schedules.set(options.scheduleId, { spec: options.spec, action: options.action, policies: options.policies, state: { paused: false } });
			},
			getHandle: (id: string) => ({
				update: async (updater: (previous: StoredSchedule) => Partial<StoredSchedule>) => {
					const previous = schedules.get(id);
					if (previous === undefined) throw new Error(`no schedule ${id}`);
					schedules.set(id, { ...previous, ...updater(previous) } as StoredSchedule);
				},
			}),
		},
	};
	return { client: client as unknown as Client, schedules };
};

const snapshotAt = (intervalSeconds: number, silenceSeconds = 90): Record<string, unknown> => ({
	"act.MachineLiveness.S": 5,
	[LIVENESS_INTERVAL_KEY]: intervalSeconds,
	[LIVENESS_SILENCE_KEY]: silenceSeconds,
});

describe("ensureMachineLivenessSchedule (fake Schedule API)", () => {
	it("the first call creates one Schedule at the setting's interval, running the control queue with overlap SKIP", async () => {
		const { client, schedules } = makeFakeClient();
		await ensureMachineLivenessSchedule(client, snapshotAt(30));
		const stored = schedules.get(MACHINE_LIVENESS_SCHEDULE_ID);
		assert.ok(stored, "the Schedule exists");
		assert.equal(schedules.size, 1);
		assert.deepEqual(stored.spec.intervals, [{ every: 30_000 }]);
		assert.equal(stored.action.workflowType, "MachineLivenessWorkflow");
		assert.equal(stored.action.taskQueue, CONTROL_QUEUE);
		assert.ok(stored.action.workflowId.startsWith("machine-liveness"), "the run workflowId starts with the machine-liveness prefix");
		assert.deepEqual(stored.action.args, [{ startToCloseSeconds: 5 }]);
		assert.equal(stored.policies.overlap, "SKIP");
	});

	it("a second call on the same settings leaves one Schedule at the same interval (no duplicate)", async () => {
		const { client, schedules } = makeFakeClient();
		await ensureMachineLivenessSchedule(client, snapshotAt(30));
		await ensureMachineLivenessSchedule(client, snapshotAt(30));
		assert.equal(schedules.size, 1);
		assert.deepEqual(schedules.get(MACHINE_LIVENESS_SCHEDULE_ID)?.spec.intervals, [{ every: 30_000 }]);
	});

	it("a changed interval updates the existing Schedule in place and keeps its paused state", async () => {
		const { client, schedules } = makeFakeClient();
		await ensureMachineLivenessSchedule(client, snapshotAt(30));
		schedules.get(MACHINE_LIVENESS_SCHEDULE_ID)!.state.paused = true;
		await ensureMachineLivenessSchedule(client, snapshotAt(45));
		const stored = schedules.get(MACHINE_LIVENESS_SCHEDULE_ID)!;
		assert.equal(schedules.size, 1);
		assert.deepEqual(stored.spec.intervals, [{ every: 45_000 }]);
		assert.equal(stored.state.paused, true, "an operator's pause survives the update");
		assert.equal(stored.policies.overlap, "SKIP");
	});

	it("an absent liveness interval refuses the call and creates no Schedule", async () => {
		const { client, schedules } = makeFakeClient();
		const snapshot = { "act.MachineLiveness.S": 5, [LIVENESS_SILENCE_KEY]: 90 };
		await assert.rejects(ensureMachineLivenessSchedule(client, snapshot), /machine-liveness schedule refused/);
		assert.equal(schedules.size, 0);
	});
});

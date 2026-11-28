// The Control Worker's start check (package 54, D28): it refuses to start when a timeout setting is unset or a local activity's
// start-to-close is not below the workflow task timeout, and otherwise polls only queue `control` with no non-local activity.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Client } from "@temporalio/client";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { startTimeSkipping } from "./temporal/bench.ts";
import type { SettingsReader } from "../db/repo/settings.ts";
import { WORKFLOW_TASK_TIMEOUT_SECONDS, allTimeoutKeys, createActivityCatalog, invalidTimeoutKeys, localTimeoutViolations } from "../control/activity-catalog.ts";
import { controlSettingsProblems, createControlWorker } from "../control/worker.ts";
import type { ControlActivities } from "../control/activities/index.ts";
import { makeStub, stubSettings } from "./temporal/task-stub.ts";

// The time-skipping server does not implement CreateSchedule, so the start's Schedule call gets a client that accepts it. The
// Schedule itself is checked by machine-liveness-schedule-client.test.ts (fake Schedule API) and machine-liveness-schedule.test.ts.
const acceptingClient = (): Client => ({ schedule: { create: async () => undefined } }) as unknown as Client;

const readerOf = (snapshot: Record<string, unknown>): SettingsReader => ({ snapshot: async (keys) => Object.fromEntries(keys.filter((key) => key in snapshot).map((key) => [key, snapshot[key]])) }) as SettingsReader;

/** The names of the local activities of the catalog (the ones whose S the bound applies to), with their S key. */
const localSKeys = (): string[] => {
	const catalog = createActivityCatalog(stubSettings() as Record<string, unknown>);
	return catalog.localNames().map((name) => allTimeoutKeys().find((key) => key.startsWith(`act.${name}.`) && key.endsWith(".S")) as string);
};

describe("Control Worker start check", () => {
	it("the bound is the workflow task timeout of the server default, 10 s", () => {
		assert.equal(WORKFLOW_TASK_TIMEOUT_SECONDS, 10);
	});

	it("settings that are all set below the bound pass", () => {
		assert.deepEqual(controlSettingsProblems(stubSettings()), []);
		assert.deepEqual(localTimeoutViolations(createActivityCatalog(stubSettings())), []);
	});

	it("a local activity whose S is at or above the bound is a violation, one just below is not", () => {
		const keys = localSKeys();
		assert.ok(keys.length > 0, "the catalog has local activities");
		for (const key of keys) {
			assert.deepEqual(controlSettingsProblems(stubSettings({ [key]: 9.99 })), [], `${key} = 9.99`);
			assert.deepEqual(controlSettingsProblems(stubSettings({ [key]: 10 })), [`${key} must be below 10`], `${key} = 10`);
			assert.deepEqual(controlSettingsProblems(stubSettings({ [key]: 60 })), [`${key} must be below 10`], `${key} = 60`);
		}
	});

	it("every violating local activity is named, not the first alone", () => {
		const keys = localSKeys();
		const problems = controlSettingsProblems(stubSettings(Object.fromEntries(keys.map((key) => [key, 30]))));
		assert.equal(problems.length, keys.length);
		for (const key of keys) assert.ok(problems.includes(`${key} must be below 10`), key);
	});

	it("an S of a non-local activity may exceed the bound: it is not run inside a workflow task", () => {
		const local = new Set(localSKeys());
		const other = allTimeoutKeys().find((key) => key.endsWith(".S") && !local.has(key));
		assert.ok(other !== undefined, "the catalog has a non-local activity with an S");
		assert.deepEqual(controlSettingsProblems(stubSettings({ [other]: 3600 })), []);
	});

	it("unset and invalid keys are all listed in one problem", () => {
		const keys = allTimeoutKeys();
		const snapshot = stubSettings();
		delete snapshot[keys[0] as string];
		snapshot[keys[1] as string] = 0;
		snapshot[keys[2] as string] = "7";
		const missing = invalidTimeoutKeys(snapshot);
		assert.deepEqual(missing, [keys[0], keys[1], keys[2]]);
		assert.deepEqual(controlSettingsProblems(snapshot), [`unset or invalid settings: ${missing.join(", ")}`]);
	});

	it("an empty settings table lists every timeout key", () => {
		const [problem] = controlSettingsProblems({});
		for (const key of allTimeoutKeys()) assert.ok(problem?.includes(key), key);
	});

	it("createControlWorker refuses to start and names every missing key (no connection is touched)", async () => {
		const snapshot = stubSettings();
		const keys = allTimeoutKeys();
		delete snapshot[keys[0] as string];
		delete snapshot[keys[3] as string];
		await assert.rejects(
			createControlWorker({ connection: null as never, client: null as never, settings: readerOf(snapshot), activities: makeStub({}).activities as unknown as ControlActivities }),
			(error: Error) => error.message.startsWith("Control Worker does not start: ") && error.message.includes(keys[0] as string) && error.message.includes(keys[3] as string),
		);
	});

	it("createControlWorker refuses to start when a local S is not below the bound", async () => {
		const key = localSKeys()[0] as string;
		await assert.rejects(
			createControlWorker({ connection: null as never, client: null as never, settings: readerOf(stubSettings({ [key]: 12 })), activities: makeStub({}).activities as unknown as ControlActivities }),
			(error: Error) => error.message === `Control Worker does not start: ${key} must be below 10`,
		);
	});
});

describe("Control Worker creation", () => {
	let env: TestWorkflowEnvironment;
	before(async () => { env = await startTimeSkipping(); });
	after(async () => { await env.teardown(); });

	it("valid settings give a Worker on queue `control` with non-local activities off", async () => {
		const worker = await createControlWorker({
			connection: env.nativeConnection, client: acceptingClient(), settings: readerOf(stubSettings()), activities: makeStub({}).activities as unknown as ControlActivities,
		});
		try {
			const options = worker.options as unknown as { taskQueue: string; enableNonLocalActivities: boolean };
			assert.equal(options.taskQueue, "control");
			assert.equal(options.enableNonLocalActivities, false);
		} finally {
			// A created Worker holds the connection until it has run and shut down; the env cannot close before that,
			// so a failed assertion above must still reach this line or the run hangs instead of failing.
			await worker.runUntil(Promise.resolve());
		}
	});
});

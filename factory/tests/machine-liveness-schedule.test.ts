// The machine-liveness Schedule against the real Temporal server of deploy/compose.yml (the time-skipping test server has no
// Schedules: CreateSchedule is UNIMPLEMENTED there). The stack is brought up the way tests/temporal-compose.test.ts does it:
// Postgres, the schema step, the server, a namespace registered by the test. The fake Schedule API is checked by
// machine-liveness-schedule-client.test.ts.
//
// A Schedule run is started with `trigger()`, so no interval has to pass: the workflowId it used is read back from the
// Schedule's recent actions and from the run itself, never assumed.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Client, Connection, ScheduleOverlapPolicy } from "@temporalio/client";
import { NativeConnection } from "@temporalio/worker";
import { freePort, realClock, runChecked, stackArgs, stackEnv, waitHealthy } from "../deploy/lib.ts";
import type { SettingsReader } from "../db/repo/settings.ts";
import { MACHINE_LIVENESS_SCHEDULE_ID } from "../control/machine-liveness-schedule.ts";
import { LIVENESS_INTERVAL_KEY, LIVENESS_SILENCE_KEY } from "../control/liveness-settings.ts";
import { createControlWorker } from "../control/worker.ts";
import type { ControlActivities } from "../control/activities/index.ts";
import { Cleanups, newBenchStackInfo } from "./helpers.ts";
import { makeStub, stubSettings } from "./temporal/task-stub.ts";

const NAMESPACE = "af-liveness-schedule-test";
// 1 day: the shortest retention the server accepts for a namespace (same as tests/temporal-compose.test.ts).
const RETENTION_SECONDS = 24 * 60 * 60;
// Same bounds as tests/temporal-compose.test.ts: the stack start is about 60 s on this machine, four times that for a loaded one.
const START_MS = 240_000;
const TEST_MS = 300_000;
// Bench value, injected here: the product has no default for the liveness settings. The silence is not under test here.
const BENCH_SILENCE_SECONDS = 60;

const readerOf = (snapshot: Record<string, unknown>): SettingsReader => ({ snapshot: async (keys) => Object.fromEntries(keys.filter((key) => key in snapshot).map((key) => [key, snapshot[key]])) }) as SettingsReader;

describe("machine-liveness Schedule on the real Temporal server, created by the Control Worker startup", { concurrency: false }, () => {
	const cleanups = new Cleanups();
	let address = "";
	let connection: Connection;
	let nativeConnection: NativeConnection;
	let client: Client;

	// Polls `check` until it returns without throwing; rethrows the last error at the deadline (conditions, not fixed waits).
	const eventually = async <T>(check: () => Promise<T>, timeoutMs = 60_000): Promise<T> => {
		const deadline = realClock.now() + timeoutMs;
		for (;;) {
			try {
				return await check();
			} catch (error) {
				if (realClock.now() >= deadline) throw error;
				await realClock.sleep(300);
			}
		}
	};

	/** Starts the Control Worker once with the given liveness interval, as the production startup does, and stops it again. */
	const startControlWorker = async (intervalSeconds: number): Promise<void> => {
		const settings = stubSettings({ [LIVENESS_INTERVAL_KEY]: intervalSeconds, [LIVENESS_SILENCE_KEY]: BENCH_SILENCE_SECONDS });
		const worker = await createControlWorker({
			connection: nativeConnection, client, namespace: NAMESPACE, settings: readerOf(settings), activities: makeStub({}).activities as unknown as ControlActivities,
		});
		// A created Worker holds the connection until it has run and shut down: run it once, then it stops.
		await worker.runUntil(Promise.resolve());
	};

	const describeSchedule = () => client.schedule.getHandle(MACHINE_LIVENESS_SCHEDULE_ID).describe();
	const scheduledEveryMs = async (): Promise<number> => Number((await describeSchedule()).spec.intervals?.[0]?.every);

	/** The ids of the Schedules of the namespace that are the machine-liveness one (the server's list is eventually consistent). */
	const listedLivenessSchedules = async (expected: number): Promise<string[]> =>
		eventually(async () => {
			const ids: string[] = [];
			for await (const entry of client.schedule.list()) if (entry.scheduleId === MACHINE_LIVENESS_SCHEDULE_ID) ids.push(entry.scheduleId);
			assert.equal(ids.length, expected, `${expected} Schedule(s) listed, found ${ids.length}`);
			return ids;
		});

	before(async () => {
		const info = await newBenchStackInfo(cleanups);
		const port = await freePort();
		address = `127.0.0.1:${port}`;
		const env = { ...stackEnv(info), AF_TEMPORAL_PORT: String(port) };
		try {
			await cleanups.track(runChecked("docker", stackArgs(info, "up", "-d", "temporal"), { env }));
		} catch (error) {
			throw new Error(`the Temporal stack did not start: ${(error as Error).message}`);
		}
		const server = (await runChecked("docker", ["ps", "-q", "--filter", `label=com.docker.compose.project=${info.project}`, "--filter", "label=com.docker.compose.service=temporal"])).split(/\s+/).filter(Boolean);
		assert.equal(server.length, 1, "one temporal container expected");
		await waitHealthy(server[0] as string, START_MS);
		connection = await Connection.connect({ address });
		cleanups.add(() => connection.close());
		// Compose creates no namespace: the application registers its own (the test does what the application's start does).
		await eventually(async () => {
			await connection.workflowService.registerNamespace({ namespace: NAMESPACE, workflowExecutionRetentionPeriod: { seconds: RETENTION_SECONDS as never } });
		});
		await eventually(async () => {
			await connection.workflowService.describeNamespace({ namespace: NAMESPACE });
		});
		client = new Client({ connection, namespace: NAMESPACE });
		nativeConnection = await NativeConnection.connect({ address });
		cleanups.add(() => nativeConnection.close());
	});

	after(async () => {
		await cleanups.runAll();
	});

	it("the first start creates the Schedule once, with the current interval", { timeout: TEST_MS }, async () => {
		await startControlWorker(30);
		assert.equal(await scheduledEveryMs(), 30_000);
		assert.equal((await describeSchedule()).policies.overlap, ScheduleOverlapPolicy.SKIP);
		await listedLivenessSchedules(1);
	});

	it("a second start updates the same Schedule in place and does not duplicate it", { timeout: TEST_MS }, async () => {
		await startControlWorker(30);
		assert.equal(await scheduledEveryMs(), 30_000);
		await startControlWorker(45);
		assert.equal(await scheduledEveryMs(), 45_000);
		await listedLivenessSchedules(1);
	});

	it("a Schedule run starts with the workflowId the Schedule reports: the prefix `machine-liveness` plus the server's suffix", { timeout: TEST_MS }, async () => {
		await client.schedule.getHandle(MACHINE_LIVENESS_SCHEDULE_ID).trigger();
		const actions = await eventually(async () => {
			const found = (await describeSchedule()).info.recentActions;
			assert.ok(found.length >= 1, "the Schedule has started a run");
			return found;
		});
		for (const result of actions) {
			const workflowId = result.action.workflow.workflowId;
			assert.ok(workflowId.startsWith(`${MACHINE_LIVENESS_SCHEDULE_ID}-`), `${workflowId} is the prefix, a dash and the server's per-run suffix`);
			assert.notEqual(workflowId, MACHINE_LIVENESS_SCHEDULE_ID, "the server adds a per-run suffix");
			const run = await client.workflow.getHandle(workflowId, result.action.workflow.firstExecutionRunId).describe();
			assert.equal(run.type, "MachineLivenessWorkflow");
			assert.equal(run.taskQueue, "control");
		}
	});
});

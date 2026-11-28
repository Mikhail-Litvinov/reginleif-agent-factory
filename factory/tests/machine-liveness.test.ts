import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";
import { drizzle } from "drizzle-orm/postgres-js";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { createControlActivities } from "../control/activities/index.ts";
import { offlineDedupKey, type MachineLivenessResult } from "../control/activities/machine-liveness.ts";
import { LIVENESS_INTERVAL_KEY, LIVENESS_SILENCE_KEY } from "../control/liveness-settings.ts";
import { migrate } from "../db/migrate.ts";
import { createRepo, type Repo } from "../db/repo/index.ts";
import { connectBench, createDatabaseBench } from "./database-bench.ts";
import { startTimeSkipping, withWorker, workflowsPathOf } from "./temporal/bench.ts";
import { CONTRACT_VERSION } from "../workflows/task-state.ts";

// Bench values, injected here: the product has no default for the liveness settings (it refuses to start without them).
// The interval 30 s is the Schedule period the ticks follow; the silence 60 s makes a worker silent after two missed ticks.
const BENCH_INTERVAL_SECONDS = 30;
const BENCH_SILENCE_SECONDS = 60;
// The MachineLiveness start-to-close in the workflow argument: 7 s, below the 10 s workflow task timeout (ActivityCatalog).
const TICK_START_TO_CLOSE_SECONDS = 7;
const TASK_QUEUE = "machine-liveness-bench";
const WORKFLOW_PATH = workflowsPathOf(new URL("../workflows/machine-liveness.ts", import.meta.url).href);

const benchPromise = createDatabaseBench(import.meta.url);
let bench: Awaited<typeof benchPromise>;
let migratorClient: ReturnType<typeof connectBench>;
let controlClient: ReturnType<typeof connectBench>;
let migratorRepo: Repo;
let controlRepo: Repo;
let env: TestWorkflowEnvironment;

const owner = "27000000-0000-7000-8000-000000000057";

// Workers and notices are not deleted between tests: migration 0001 puts af_refuse_delete triggers on `workers`, and the
// bench database is disposable per test file. Every test therefore checks only its own worker id, and the other workers
// the earlier tests left behind may appear in a tick's result without affecting the assertions.

const seedWorker = async (id: string, lastSeenAt: Date | null, status = "online", contractVersion = CONTRACT_VERSION): Promise<void> => {
	await migratorClient`INSERT INTO workers (id, machine_id, name, platform, capabilities, version, contract_version, last_seen_at, status, concurrency_limit)
		VALUES (${id}, ${`machine-${id}`}, ${`worker ${id}`}, 'windows', ${"{}"}::jsonb, '0.0.0', ${contractVersion},${lastSeenAt === null ? null : lastSeenAt.toISOString()}::timestamptz, ${status}, 1)`;
};

const workerStatus = async (id: string): Promise<string | undefined> => {
	const rows = await migratorClient<{ status: string }[]>`SELECT status FROM workers WHERE id = ${id}`;
	return rows[0]?.status;
};

/** The notices of one worker's outages, oldest first: `resolved` is whether the notice has resolved_at set. */
const noticesOf = async (workerId: string): Promise<{ state: string; resolved: boolean }[]> => {
	const rows = await migratorClient<{ state: string; resolved: boolean }[]>`SELECT state, (resolved_at IS NOT NULL) AS resolved FROM notifications
		WHERE dedup_key = ${offlineDedupKey(workerId)} ORDER BY seq`;
	// Plain objects: the driver's result rows carry array metadata that deepEqual would compare too.
	return rows.map((row) => ({ state: row.state, resolved: row.resolved }));
};

/** Runs `body` on a Worker that polls the liveness queue; `tick` starts one MachineLivenessWorkflow run (one Schedule tick). */
const runTicks = <T>(body: (tick: () => Promise<MachineLivenessResult>) => Promise<T>): Promise<T> =>
	withWorker(
		{ env, taskQueue: TASK_QUEUE, workflowsPath: WORKFLOW_PATH, activities: createControlActivities(controlRepo, drizzle(controlClient)) },
		() => body(async () => (await env.client.workflow.execute("MachineLivenessWorkflow", {
			taskQueue: TASK_QUEUE,
			workflowId: `machine-liveness-tick-${randomUUID()}`,
			args: [{ startToCloseSeconds: TICK_START_TO_CLOSE_SECONDS }],
		})) as MachineLivenessResult),
	);

before(async () => {
	bench = await benchPromise;
	await migrate({ url: bench.migratorUrl });
	migratorClient = connectBench(bench.migratorUrl);
	migratorRepo = createRepo(drizzle(migratorClient));
	await migratorClient`INSERT INTO owners (id, name) VALUES (${owner}, 'liveness owner')`;
	controlClient = connectBench(bench.controlUrl);
	controlRepo = createRepo(drizzle(controlClient));
	env = await startTimeSkipping();
});

beforeEach(async () => {
	await migratorRepo.settings.set(LIVENESS_INTERVAL_KEY, BENCH_INTERVAL_SECONDS, owner);
	await migratorRepo.settings.set(LIVENESS_SILENCE_KEY, BENCH_SILENCE_SECONDS, owner);
});

after(async () => {
	await env?.teardown();
	await controlClient?.end();
	await migratorClient?.end();
	await bench?.dispose();
});

describe("MachineLivenessWorkflow on the temporal bench (time skipping)", () => {
	test("a worker silent longer than the threshold becomes OFFLINE and gets one worker_offline notice", async () => {
		const id = randomUUID();
		await seedWorker(id, new Date(await env.currentTimeMs()));
		await runTicks(async (tick) => {
			await env.sleep((BENCH_SILENCE_SECONDS + 1) * 1000);
			const result = await tick();
			assert.equal(result.wentOffline.includes(id), true);
		});
		assert.equal(await workerStatus(id), "offline");
		assert.deepEqual(await noticesOf(id), [{ state: "open", resolved: false }]);
	});

	test("continued silence gives no second notice and no second transition", async () => {
		const id = randomUUID();
		await seedWorker(id, new Date(await env.currentTimeMs()));
		await runTicks(async (tick) => {
			await env.sleep((BENCH_SILENCE_SECONDS + 1) * 1000);
			await tick();
			await env.sleep(BENCH_INTERVAL_SECONDS * 1000);
			const result = await tick();
			assert.equal(result.wentOffline.includes(id), false);
			assert.equal(result.wentOnline.includes(id), false);
		});
		assert.equal(await workerStatus(id), "offline");
		assert.deepEqual(await noticesOf(id), [{ state: "open", resolved: false }]);
	});

	test("recovery resolves the notice; new silence after recovery gives a new notice", async () => {
		const id = randomUUID();
		await seedWorker(id, new Date(await env.currentTimeMs()));
		await runTicks(async (tick) => {
			await env.sleep((BENCH_SILENCE_SECONDS + 1) * 1000);
			await tick();
			await controlRepo.workers.heartbeat(id, undefined, new Date(await env.currentTimeMs()));
			await env.sleep(BENCH_INTERVAL_SECONDS * 1000);
			const recovered = await tick();
			assert.equal(recovered.wentOnline.includes(id), true);
			assert.equal(await workerStatus(id), "online");
			assert.deepEqual(await noticesOf(id), [{ state: "resolved", resolved: true }]);
			await env.sleep((BENCH_SILENCE_SECONDS + 1) * 1000);
			const silentAgain = await tick();
			assert.equal(silentAgain.wentOffline.includes(id), true);
		});
		assert.equal(await workerStatus(id), "offline");
		assert.deepEqual(await noticesOf(id), [
			{ state: "resolved", resolved: true },
			{ state: "open", resolved: false },
		]);
	});

	test("a worker on an unsupported contract comes back OUTDATED, never ONLINE", async () => {
		const id = randomUUID();
		// Contract 0 is outside the supported range (the current version only; tasks.ts checkContract): the worker gets no work.
		await seedWorker(id, new Date(await env.currentTimeMs()), "online", 0);
		await runTicks(async (tick) => {
			await env.sleep((BENCH_SILENCE_SECONDS + 1) * 1000);
			await tick();
			await controlRepo.workers.heartbeat(id, undefined, new Date(await env.currentTimeMs()));
			await env.sleep(BENCH_INTERVAL_SECONDS * 1000);
			const recovered = await tick();
			assert.equal(recovered.wentOnline.includes(id), true);
			assert.equal(await workerStatus(id), "outdated");
		});
		assert.deepEqual(await noticesOf(id), [{ state: "resolved", resolved: true }]);
	});

	test("the threshold is the setting liveness.silenceSeconds, not a constant", async () => {
		const id = randomUUID();
		await seedWorker(id, new Date(await env.currentTimeMs()));
		await migratorRepo.settings.set(LIVENESS_SILENCE_KEY, 120, owner);
		await runTicks(async (tick) => {
			// 61 s of silence: over the 60 s the other tests use, under the 120 s set here, so the worker stays online.
			await env.sleep((BENCH_SILENCE_SECONDS + 1) * 1000);
			const withinThreshold = await tick();
			assert.equal(withinThreshold.wentOffline.includes(id), false);
			assert.equal(await workerStatus(id), "online");
			// 121 s of silence: over 120 s, so the same worker goes OFFLINE.
			await env.sleep(60 * 1000);
			const beyondThreshold = await tick();
			assert.equal(beyondThreshold.wentOffline.includes(id), true);
		});
		assert.equal(await workerStatus(id), "offline");
	});
});

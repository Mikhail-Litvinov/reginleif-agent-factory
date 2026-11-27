import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "../db/migrate.ts";
import { createRepo } from "../db/repo/index.ts";
import { connectBench, createDatabaseBench } from "./database-bench.ts";
import { PersistTaskEvent } from "../control/index.ts";

const benchPromise = createDatabaseBench(import.meta.url);
let bench: Awaited<typeof benchPromise>;
let controlClient: ReturnType<typeof connectBench>;
let controlRepo: ReturnType<typeof createRepo>;
let taskId = "26000000-0000-7000-8000-000000000001";

before(async () => {
	bench = await benchPromise;
	await migrate({ url: bench.migratorUrl });
	const migrationClient = connectBench(bench.migratorUrl);
	const migrationRepo = createRepo(drizzle(migrationClient));
	await migrationRepo.projects.create({ id: "26000000-0000-7000-8000-000000000002", name: "control-test", workspacePolicy: "worktree" });
	await migrationRepo.tasks.create({ id: taskId, projectId: "26000000-0000-7000-8000-000000000002", title: "control-test", priority: 1 }, {
		id: "26000000-0000-7000-8000-000000000003", requirements: "test", acceptanceCriteria: [], constraints: {},
	});
	await migrationClient.end();
	controlClient = connectBench(bench.controlUrl);
	controlRepo = createRepo(drizzle(controlClient));
});

after(async () => {
	await controlClient?.end();
	await bench?.dispose();
});

test("PersistTaskEvent writes one event and retry returns it without another row", async () => {
	const event = {
		id: "26000000-0000-7000-8000-000000000004", taskId, runId: null, eventType: "phase2_test",
		actorType: "workflow" as const, actorId: null, payload: { status: "PLANNING" }, correlationId: null, dedupeKey: "phase2-test",
	};
	const first = await PersistTaskEvent(controlRepo.taskEvents, event);
	const retry = await PersistTaskEvent(controlRepo.taskEvents, event);
	assert.equal(first.id, event.id);
	assert.equal(retry.id, first.id);
	assert.equal((await controlRepo.taskEvents.stream({ below: "18446744073709551615", taskId })).filter((row) => row.dedupeKey === event.dedupeKey).length, 1);
});

test("af_control is refused a forbidden delete statement", async () => {
	await assert.rejects(controlClient`DELETE FROM task_events WHERE id = ${"26000000-0000-7000-8000-000000000004"}`,
		(error: unknown) => (error as { code?: string }).code === "42501");
});

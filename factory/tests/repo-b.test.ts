import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { migrate } from "../db/migrate.ts";
import { createRepo } from "../db/repo/index.ts";
import { DependencyRefusedError, TaskDeleteRefusedError, TransitionRefusedError } from "../db/repo/tasks.ts";
import { taskRevisions } from "../db/schema/decisions.ts";
import { connectBench, databaseBench } from "./database-bench.ts";

const benchPromise = databaseBench(import.meta.url);
let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle>;
let repo: ReturnType<typeof createRepo>;

before(async () => {
	const bench = await benchPromise;
	await migrate({ url: bench.migratorUrl });
	client = connectBench(bench.migratorUrl);
	db = drizzle(client);
	repo = createRepo(db);
});
after(async () => { await client?.end(); });

const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
let projectId = 1;
let taskId = 100;

const makeTask = async (options: { projectId?: string; priority?: number } = {}) => {
	const project = await repo.projects.create({ id: id(projectId), name: `repo-b-${projectId}`, workspacePolicy: "worktree" });
	const task = await repo.tasks.create({
		id: id(taskId), projectId: options.projectId ?? project.id, title: `task-${taskId}`, priority: options.priority ?? 2, createdBy: id(777),
	}, {
		id: id(taskId + 1000), requirements: `requirements-${taskId}`, acceptanceCriteria: [], constraints: {},
	});
	projectId++;
	taskId++;
	return task;
};

describe("migration 0002 and 0003 repositories", () => {
	it("creates task and initial revision, reads and filters tasks, transitions and soft deletes with row versions", async () => {
		const task = await makeTask({ priority: 4 });
		assert.equal(task.rowVersion, 1n);
		assert.equal((await repo.tasks.get(task.id))?.title, task.title);
		assert.equal((await repo.tasks.revisions(task.id))[0]?.revisionNumber, 1);
		assert.equal((await repo.tasks.revisions(task.id))[0]?.changeReason, "initial");
		assert.equal((await repo.tasks.list({ projectId: task.projectId!, priorityGte: 4, q: task.title! })).length, 1);
		assert.equal((await repo.tasks.transition(task.id, 1n, "PLANNING"))?.rowVersion, 2n);
		assert.equal(await repo.tasks.transition(task.id, 1n, "READY"), null);
		await assert.rejects(repo.tasks.softDelete(task.id, 2n), (error: unknown) =>
			error instanceof TaskDeleteRefusedError && error.reason === "task cannot be deleted");
		assert.equal((await repo.tasks.transition(task.id, 2n, "READY"))?.status, "READY");
		await assert.rejects(repo.tasks.softDelete(task.id, 3n), (error: unknown) =>
			error instanceof TaskDeleteRefusedError && error.reason === "task cannot be deleted");
		await repo.tasks.transition(task.id, 3n, "WAITING_DEPENDENCIES");
		await repo.tasks.transition(task.id, 4n, "ASSIGNED");
		await repo.tasks.transition(task.id, 5n, "RUNNING");
		await repo.tasks.transition(task.id, 6n, "VERIFYING");
		await repo.tasks.transition(task.id, 7n, "AWAITING_APPROVAL");
		await repo.tasks.transition(task.id, 8n, "ACCEPTED");
		assert.equal((await repo.tasks.softDelete(task.id, 9n))?.rowVersion, 10n);
		assert.equal(await repo.tasks.get(task.id), undefined);
		assert.equal((await repo.tasks.get(task.id, { includeDeleted: true }))?.deletedAt instanceof Date, true);
	});

	it("returns typed transition refusals with the database reason", async () => {
		const task = await makeTask();
		await assert.rejects(repo.tasks.transition(task.id, 1n, "ACCEPTED"), (error: unknown) =>
			error instanceof TransitionRefusedError && error.reason === "illegal task transition");
		await assert.rejects(repo.tasks.transition(task.id, 1n, "PLANNING", { blockKind: "dependency" }), (error: unknown) =>
			error instanceof TransitionRefusedError && error.reason === "block kind and handler require BLOCKED");
	});

	it("adds and removes same-project dependencies and maps cycle refusal", async () => {
		const first = await makeTask();
		const second = await makeTask({ projectId: first.projectId! });
		const third = await makeTask({ projectId: first.projectId! });
		await repo.tasks.addDependency(first.id, second.id, "requires_accepted");
		await repo.tasks.addDependency(second.id, third.id, "requires_accepted");
		await assert.rejects(repo.tasks.addDependency(third.id, first.id, "requires_accepted"), (error: unknown) =>
			error instanceof DependencyRefusedError && error.reason === "dependency_cycle");
		assert.equal((await repo.tasks.dependencies(first.id)).length, 1);
		assert.equal((await repo.tasks.removeDependency(first.id, second.id, 1n))?.removedAt instanceof Date, true);
		assert.equal(await repo.tasks.removeDependency(first.id, second.id, 1n), null);
		assert.equal((await repo.tasks.dependencies(first.id)).length, 0);
		assert.equal((await repo.tasks.dependencies(first.id, { includeRemoved: true })).length, 1);
	});

	it("appends ordered immutable revisions", async () => {
		const task = await makeTask();
		const next = await repo.tasks.appendRevision(task.id, {
			id: id(taskId + 1000), requirements: "changed", acceptanceCriteria: [{ id: "one" }], constraints: {},
			changeReason: "owner request", authorId: id(999),
		});
		assert.equal(next?.revisionNumber, 2);
		assert.equal((await repo.tasks.getRevision(task.id, 2))?.requirements, "changed");
		assert.deepEqual((await repo.tasks.revisions(task.id)).map((revision) => revision.revisionNumber), [1, 2]);
		await assert.rejects(db.update(taskRevisions).set({ requirements: "mutated" }).where(eq(taskRevisions.taskId, task.id)), /immutable/i);
	});
});

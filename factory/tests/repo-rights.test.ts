import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { migrate } from "../db/migrate.ts";
import { createRepo } from "../db/repo/index.ts";
import { RightAnswerRefusedError } from "../db/repo/rights.ts";
import { auditLog } from "../db/schema/audit-log.ts";
import { outboxEvents } from "../db/schema/decisions.ts";
import { agents } from "../db/schema/agents.ts";
import { owners } from "../db/schema/owners.ts";
import { regulationVersions } from "../db/schema/registry.ts";
import { taskRuns } from "../db/schema/runs.ts";
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

const id = (n: number) => `20000000-0000-7000-8000-${String(n).padStart(12, "0")}`;

describe("migration 0007 rights repositories", () => {
	it("covers role, assignment, request, and answer methods and maps answer-order refusals", async () => {
		await db.insert(regulationVersions).values({ id: id(1), number: 1, status: "draft", clauses: [], clausesBytes: 0 });
		await repo.projects.create({ id: id(2), name: "repo-rights-project", workspacePolicy: "worktree" });
		const task = await repo.tasks.create({ id: id(3), projectId: id(2), title: "rights task", priority: 1 }, {
			id: id(4), requirements: "requirements", acceptanceCriteria: [], constraints: {},
		});
		const role = await repo.roles.create({
			id: id(5), name: "implementer", version: 1, status: "draft", rights: [{ action: "read", target: "repo", conditions: {} }], deny: [], regulationVersionId: id(1),
		});
		assert.equal((await repo.roles.get(role.id))?.id, role.id);
		assert.equal((await repo.roles.list({ name: role.name!, status: "draft", regulationVersionId: id(1) })).length, 1);
		assert.equal((await repo.roles.setStatus(role.id, "draft"))?.status, "draft");

		const assignment = await repo.roleAssignments.create({ id: id(6), taskId: task.id, participant: "builder", roleId: role.id, assignedBy: { type: "owner", id: id(7) } });
		assert.equal((await repo.roleAssignments.get(assignment.id))?.id, assignment.id);
		assert.equal((await repo.roleAssignments.listForTask(task.id)).length, 1);
		assert.equal((await repo.roleAssignments.supersede(assignment.id))?.supersededAt instanceof Date, true);
		assert.equal((await repo.roleAssignments.listForTask(task.id)).length, 0);
		assert.equal((await repo.roleAssignments.listForTask(task.id, { includeSuperseded: true })).length, 1);

		await repo.agents.create({ id: id(8), name: "rights-requester", provider: "test", adapterType: "test", capabilities: [], enabled: true, concurrencyLimit: 1, configuration: {} });
		await db.insert(taskRuns).values({ id: id(9), taskId: task.id, attemptNumber: 1, role: "implementer", participant: "builder", agentId: id(8), status: "running", executionId: id(10) });
		const request = await repo.rightRequests.create({
			id: id(11), taskId: task.id, runId: id(9), participant: "builder", action: "read", target: "repo/file", conditions: {}, reason: "need file", tried: "checked", requestHash: "rights-request-hash", handlingTaskId: task.id,
		});
		assert.equal((await repo.rightRequests.get(request.id))?.id, request.id);
		assert.equal((await repo.rightRequests.list({ taskId: task.id, participant: "builder", requestHash: request.requestHash! })).length, 1);
		const sessionRequest = await repo.rightRequests.create({ id: id(12), sessionRef: "ordinary-session", action: "read", target: "repo/file", conditions: {}, reason: "need file", tried: "checked", requestHash: "session-request-hash", handlingTaskId: task.id });
		assert.equal((await repo.rightRequests.list({ sessionRef: "ordinary-session" }))[0]?.id, sessionRequest.id);

		const callOwner = await repo.rightAnswers.create({ id: id(13), requestId: request.id, step: 1, stepKind: "code", answer: "call_owner", answeredBy: { type: "code" }, reason: "owner list" });
		assert.equal((await repo.rightAnswers.listForRequest(request.id))[0]?.id, callOwner.id);
		await assert.rejects(
			repo.rightAnswers.create({ id: id(14), requestId: request.id, step: 3, stepKind: "owner", answer: "refuse", answeredBy: { type: "owner", id: id(7) }, reason: "out of order" }),
			(error: unknown) => error instanceof RightAnswerRefusedError && error.reason === "invalid answer order",
		);
		assert.equal((await repo.rightAnswers.listForRequest(request.id)).length, 1);
	});

	it("ends a grant with its stop order in the same transaction, then suspends and restores without reviving the grant", async () => {
		await db.insert(regulationVersions).values({ id: id(20), number: 1, status: "draft", clauses: [], clausesBytes: 0 });
		await repo.projects.create({ id: id(21), name: "repo-rights-lifecycle-project", workspacePolicy: "worktree" });
		const task = await repo.tasks.create({ id: id(22), projectId: id(21), title: "rights lifecycle", priority: 1 }, {
			id: id(23), requirements: "requirements", acceptanceCriteria: [], constraints: {},
		});
		await repo.agents.create({ id: id(24), name: "rights-subject", provider: "test", adapterType: "test", capabilities: [], enabled: true, concurrencyLimit: 1, configuration: {} });
		await repo.agents.create({ id: id(25), name: "rights-chief-engineer", provider: "test", adapterType: "test", capabilities: [], enabled: true, concurrencyLimit: 1, configuration: {} });
		await db.insert(owners).values({ id: id(26), name: "rights-owner" });
		await db.insert(taskRuns).values({ id: id(27), taskId: task.id, attemptNumber: 1, role: "implementer", participant: "builder", agentId: id(24), status: "running", executionId: id(28) });
		const request = await repo.rightRequests.create({
			id: id(29), taskId: task.id, runId: id(27), participant: "builder", action: "read", target: "repo/file", conditions: {}, reason: "need file", tried: "checked", requestHash: "grant-request-hash", handlingTaskId: task.id,
		});
		await db.insert(taskRuns).values({ id: id(30), taskId: task.id, attemptNumber: 2, role: "chief_engineer", agentId: id(25), status: "running", executionId: id(31) });
		const grantAnswer = await repo.rightAnswers.create({
			id: id(32), requestId: request.id, step: 1, stepKind: "chief_engineer", answer: "grant", clauseId: "rights.clause", answeredBy: { type: "run", id: id(30) }, answerRunId: id(30), reason: "approved",
		});
		assert.equal((await repo.rightAnswers.listForRequest(request.id))[0]?.id, grantAnswer.id);
		const grant = (await repo.rightGrants.list({ taskId: task.id, participant: "builder", state: "live" })).find((row) => row.requestId === request.id)!;
		assert.ok(grant);
		assert.equal((await repo.rightGrants.get(grant.id))?.id, grant.id);
		await db.update(taskRuns).set({ profileRights: [{ source: grant.id }] }).where(eq(taskRuns.id, id(27)));

		const rollback = new Error("roll grant ending and stop order back together");
		await assert.rejects(repo.transaction(async (tx) => {
			assert.equal((await tx.rightGrants.end(grant.id, { endedBy: "task_end" }))?.endedBy, "task_end");
			assert.equal((await tx.rightGrants.list({ taskId: task.id, state: "ended" })).some((row) => row.id === grant.id), true);
			const stop = (await tx.outbox.listPending()).find((row) => row.kind === "stop_run" && row.payload && (row.payload as { run_id?: string }).run_id === id(27));
			assert.ok(stop, "the grant end must enqueue a stop order before the transaction commits");
			assert.equal(await tx.rightGrants.get(grant.id).then((row) => row?.endedBy), "task_end");
			throw rollback;
		}), (error: unknown) => error === rollback);
		assert.equal((await repo.rightGrants.get(grant.id))?.endedAt, null);
		assert.equal((await db.select().from(outboxEvents).where(eq(outboxEvents.kind, "stop_run"))).some((row) => (row.payload as { run_id?: string } | null)?.run_id === id(27)), false);

		await db.insert(auditLog).values({ id: id(33), action: "rights.suspend", targetType: "rights_suspensions", targetId: id(34), outcome: "ok" });
		const suspension = await repo.rightsSuspensions.create({ id: id(34), agentId: id(24), runId: id(27), taskId: task.id, eventKey: "rights-stop-event", reason: "owner_stop", auditId: id(33) });
		assert.equal((await repo.rightsSuspensions.get(suspension.id))?.id, suspension.id);
		assert.equal((await repo.rightsSuspensions.list({ agentId: id(24), state: "open" })).length, 1);
		assert.equal((await repo.rightGrants.get(grant.id))?.endedBy, "critical");
		assert.equal((await repo.rightGrants.list({ taskId: task.id, state: "critical" })).some((row) => row.id === grant.id), true);
		assert.equal((await repo.rightGrants.list({ taskId: task.id, state: "revoked" })).length, 0);

		await db.insert(auditLog).values({ id: id(35), action: "rights.restore", targetType: "rights_suspensions", targetId: suspension.id, outcome: "ok" });
		const restored = await repo.rightsSuspensions.restore(suspension.id, { restoredBy: { type: "run", id: id(30) }, restoreReason: "review complete", restoreAuditId: id(35) });
		assert.equal(restored?.endedAt instanceof Date, true);
		assert.equal((await repo.rightsSuspensions.list({ agentId: id(24), state: "open" })).length, 0);
		assert.equal((await repo.rightsSuspensions.list({ agentId: id(24), state: "restored" })).length, 1);
		assert.equal((await repo.rightGrants.get(grant.id))?.endedBy, "critical");
		assert.equal((await repo.rightGrants.list({ taskId: task.id, state: "live" })).length, 0);
	});
});

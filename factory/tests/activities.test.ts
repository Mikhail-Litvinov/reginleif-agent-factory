import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "../db/migrate.ts";
import { createRepo } from "../db/repo/index.ts";
import { agents } from "../db/schema/agents.ts";
import { notifications } from "../db/schema/decisions.ts";
import { taskRuns } from "../db/schema/runs.ts";
import { taskReviews, taskProposals } from "../db/schema/reviews.ts";
import { tasks } from "../db/schema/tasks.ts";
import { connectBench, createDatabaseBench } from "./database-bench.ts";
import { NotifyUser } from "../control/activities/notify-user.ts";
import { CreateChildTasks } from "../control/activities/create-child-tasks.ts";
import { RequestReview } from "../control/activities/request-review.ts";

const benchPromise = createDatabaseBench(import.meta.url);
let bench: Awaited<typeof benchPromise>;
let controlClient: ReturnType<typeof connectBench>;
let migratorClient: ReturnType<typeof connectBench>;
let control: ReturnType<typeof drizzle>;
let admin: ReturnType<typeof drizzle>;

const id = (n: number) => `52000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const project = id(1);
const runOf = (taskNo: number) => id(taskNo + 700);
const now = new Date("2026-01-01T00:00:00Z");

const planner = id(3);
const reviewerRoles = { roles: ["reviewer"] };
// database.md task_runs.usage_metrics: tokens_in, tokens_out, cost_estimate (in the policy's currency). Source: small test values.
const measured = (tokensIn: number, tokensOut: number, cost: number) => ({ tokens_in: tokensIn, tokens_out: tokensOut, cost_estimate: cost });
const seedTask = async (taskNo: number, criteria: { id: string }[], withRun = true, usage: Record<string, unknown> | null = measured(10, 5, 0.5)) => {
	const repo = createRepo(admin);
	await repo.tasks.create({ id: id(taskNo), projectId: project, title: `t${taskNo}`, priority: 1 }, { id: id(taskNo + 500), requirements: "r", acceptanceCriteria: criteria, constraints: {} });
	if (withRun) await admin.insert(taskRuns).values({ id: runOf(taskNo), taskId: id(taskNo), attemptNumber: 1, role: "planner", agentId: planner, status: "finished", usageMetrics: usage });
	return id(taskNo);
};

before(async () => {
	bench = await benchPromise;
	await migrate({ url: bench.migratorUrl });
	migratorClient = connectBench(bench.migratorUrl);
	admin = drizzle(migratorClient);
	await createRepo(admin).projects.create({ id: project, name: "activities-test", workspacePolicy: "worktree" });
	await admin.insert(agents).values({ id: planner, name: "planner", provider: "gamma", enabled: true });
	// Source: the limits below are test inputs chosen small enough to hit each boundary once.
	await createRepo(admin).policies.create({ id: id(2), projectId: project, allowedCommands: ["node"], autoAcceptLowRisk: false, maxChildDepth: 1, maxChildrenPerTask: 2, maxTokens: 1000, maxCost: "10" });
	controlClient = connectBench(bench.controlUrl);
	control = drizzle(controlClient);
});

after(async () => {
	await controlClient?.end();
	await migratorClient?.end();
	await bench?.dispose();
});

test("NotifyUser: one open notice per dedup key, a retry returns the same row", async () => {
	const taskId = await seedTask(10, []);
	const input = { id: id(11), eventType: "task_blocked" as never, dedupKey: "blocked:10", taskId, now };
	const first = await NotifyUser(control, input);
	const retry = await NotifyUser(control, { ...input, id: id(12) });
	assert.equal(first.created, true);
	assert.equal(retry.created, false);
	assert.equal(retry.notification.id, id(11));
	assert.equal((await admin.select().from(notifications).where(eq(notifications.dedupKey, "blocked:10"))).length, 1);
});

test("NotifyUser: a raise of an open key bumps occurrences and last_raised_at; two concurrent raises give occurrences 2", async () => {
	const taskId = await seedTask(13, []);
	const first = await NotifyUser(control, { id: id(15), eventType: "task_blocked" as never, dedupKey: "blocked:bump", taskId, now });
	const later = new Date("2026-01-02T00:00:00Z");
	const bumped = await NotifyUser(control, { id: id(16), eventType: "task_blocked" as never, dedupKey: "blocked:bump", taskId, now: later });
	assert.equal(first.created, true);
	assert.equal(bumped.created, false);
	assert.equal(bumped.notification.id, id(15));
	assert.equal(bumped.notification.occurrences, 2);
	assert.equal(bumped.notification.lastRaisedAt?.getTime(), later.getTime());

	// A second connection, so the two raises really race on the index entry rather than queue on one connection.
	const otherClient = connectBench(bench.controlUrl);
	try {
		const [a, b] = await Promise.all([
			NotifyUser(control, { id: id(17), eventType: "task_blocked" as never, dedupKey: "blocked:race", taskId, now }),
			NotifyUser(drizzle(otherClient), { id: id(18), eventType: "task_blocked" as never, dedupKey: "blocked:race", taskId, now }),
		]);
		assert.deepEqual([a.created, b.created].sort(), [false, true]);
		const rows = await admin.select().from(notifications).where(eq(notifications.dedupKey, "blocked:race"));
		assert.equal(rows.length, 1);
		assert.equal(rows[0]!.occurrences, 2);
	} finally {
		await otherClient.end();
	}
});

test("CreateChildTasks: covered proposal inside the limits becomes a child; retry makes no second child", async () => {
	const parent = await seedTask(20, [{ id: "c1" }, { id: "c2" }]);
	const proposal = { id: id(21), title: "child", requirements: "do c1", covers: ["c1"] };
	const first = await CreateChildTasks(control, { parentTaskId: parent, runId: runOf(20), proposals: [proposal] }).catch((e) => e);
	if (first instanceof Error) throw first;
	assert.equal(first[0]!.state, "auto_created");
	const child = (await admin.select().from(tasks).where(eq(tasks.id, first[0]!.childTaskId!)))[0]!;
	assert.equal(child.parentTaskId, parent);
	assert.equal(child.originType, "decomposition");
	const retry = await CreateChildTasks(control, { parentTaskId: parent, runId: runOf(20), proposals: [proposal] });
	assert.equal(retry[0]!.replayed, true);
	assert.equal(retry[0]!.childTaskId, child.id);
	assert.equal((await admin.select().from(tasks).where(eq(tasks.parentTaskId, parent))).length, 1);
});

test("CreateChildTasks: covers outside the parent's criteria stays open and creates no child", async () => {
	const parent = await seedTask(30, [{ id: "c1" }]);
	const [outcome] = await CreateChildTasks(control, { parentTaskId: parent, runId: runOf(30), proposals: [{ id: id(31), title: "x", requirements: "x", covers: ["zzz"] }] });
	assert.equal(outcome!.state, "open");
	assert.equal(outcome!.reason, "covers_unknown");
	assert.equal((await admin.select().from(tasks).where(eq(tasks.parentTaskId, parent))).length, 0);
	assert.equal((await admin.select().from(taskProposals).where(eq(taskProposals.id, id(31))))[0]!.state, "open");
});

test("CreateChildTasks: children per parent limit from the policy (2) leaves the third open", async () => {
	const parent = await seedTask(40, [{ id: "c1" }]);
	const proposals = [41, 42, 43].map((n) => ({ id: id(n), title: `p${n}`, requirements: "x", covers: ["c1"] }));
	const outcomes = await CreateChildTasks(control, { parentTaskId: parent, runId: runOf(40), proposals });
	assert.deepEqual(outcomes.map((o) => o.state), ["auto_created", "auto_created", "open"]);
	assert.equal(outcomes[2]!.reason, "children");
});

test("CreateChildTasks: depth limit from the policy (1) leaves a grandchild open", async () => {
	const parent = await seedTask(50, [{ id: "c1" }]);
	const [child] = await CreateChildTasks(control, { parentTaskId: parent, runId: runOf(50), proposals: [{ id: id(51), title: "c", requirements: "x", covers: ["c1"] }] });
	await admin.insert(taskRuns).values({ id: id(53), taskId: child!.childTaskId!, attemptNumber: 1, role: "planner", agentId: planner, status: "finished", usageMetrics: measured(1, 1, 0.1) });
	// The child holds the covered criterion; its own decomposition would reach depth 2 > 1.
	const [grand] = await CreateChildTasks(control, { parentTaskId: child!.childTaskId!, runId: id(53), proposals: [{ id: id(52), title: "g", requirements: "x", covers: ["c1"] }] });
	assert.equal(grand!.state, "open");
	assert.equal(grand!.reason, "depth");
});

test("CreateChildTasks: the budget sums tokens_in + tokens_out and cost_estimate over the root's tree", async () => {
	const proposal = (n: number) => [{ id: id(n), title: "c", requirements: "x", covers: ["c1"] }];
	// Policy limits: 1000 tokens, cost 10. 700 + 200 tokens is inside, the child's own run then pushes the tree over.
	const inside = await seedTask(64, [{ id: "c1" }], true, measured(700, 200, 9));
	assert.equal((await CreateChildTasks(control, { parentTaskId: inside, runId: runOf(64), proposals: proposal(65) }))[0]!.state, "auto_created");
	const overTokens = await seedTask(66, [{ id: "c1" }], true, measured(600, 400, 1));
	const [tokens] = await CreateChildTasks(control, { parentTaskId: overTokens, runId: runOf(66), proposals: proposal(67) });
	assert.equal(tokens!.reason, "budget");
	const overCost = await seedTask(68, [{ id: "c1" }], true, measured(1, 1, 10));
	const [cost] = await CreateChildTasks(control, { parentTaskId: overCost, runId: runOf(68), proposals: proposal(69) });
	assert.equal(cost!.reason, "budget");
	// A child's spend counts against the root: the child run's tokens push the tree over the limit.
	const root = await seedTask(90, [{ id: "c1" }], true, measured(400, 0, 0));
	const [made] = await CreateChildTasks(control, { parentTaskId: root, runId: runOf(90), proposals: proposal(91) });
	await admin.insert(taskRuns).values({ id: id(93), taskId: made!.childTaskId!, attemptNumber: 1, role: "implementer", agentId: planner, status: "finished", usageMetrics: measured(600, 0, 0) });
	const [again] = await CreateChildTasks(control, { parentTaskId: root, runId: runOf(90), proposals: proposal(92) });
	assert.equal(again!.reason, "budget");
});

test("CreateChildTasks: spend that cannot be measured keeps the proposal open (budget_unmeasured)", async () => {
	// A run without the three usage_metrics keys is unmeasured, not zero (database.md task_runs.usage_metrics).
	const parent = await seedTask(60, [{ id: "c1" }], true, null);
	const [outcome] = await CreateChildTasks(control, { parentTaskId: parent, runId: runOf(60), proposals: [{ id: id(63), title: "c", requirements: "x", covers: ["c1"] }] });
	assert.equal(outcome!.state, "open");
	assert.equal(outcome!.reason, "budget_unmeasured");
	assert.equal((await admin.select().from(tasks).where(eq(tasks.parentTaskId, parent))).length, 0);
});

test("RequestReview: picks another provider; the trigger still refuses a same-provider review (review-provider)", async () => {
	const taskId = await seedTask(70, [], false);
	const [implementer, sameProvider, other] = [id(71), id(72), id(73)];
	await admin.insert(agents).values([
		{ id: implementer, name: "impl", provider: "alpha", enabled: true },
		{ id: sameProvider, name: "same", provider: "alpha", enabled: true, capabilities: reviewerRoles },
		{ id: other, name: "other", provider: "beta", enabled: true, capabilities: reviewerRoles },
		// Another provider but no reviewer role (the seeded planner is such an agent): never picked, whatever its id.
		{ id: id(7), name: "noreview", provider: "delta", enabled: true, capabilities: { roles: ["planner"] } },
	]);
	await admin.insert(taskRuns).values([
		{ id: id(74), taskId, attemptNumber: 1, role: "implementer", agentId: implementer, status: "finished" },
		{ id: id(75), taskId, attemptNumber: 2, role: "reviewer", agentId: sameProvider, status: "finished" },
	]);
	const checks = [{ name: "tests", mandatory: true, status: "passed" as const }];
	const choice = await RequestReview(control, { taskId, round: 1, checks, repairAttempted: false });
	assert.equal(choice.kind, "reviewer");
	assert.equal(choice.kind === "reviewer" ? choice.agentId : null, other);
	assert.equal((await RequestReview(control, { taskId, round: 1, checks, repairAttempted: false })).kind, "reviewer");
	await assert.rejects(control.insert(taskReviews).values({ id: id(76), taskId, runId: id(75), reviewerId: sameProvider, round: 1, verdict: "pass", findings: [] }), (error: Error) => /independent/.test(String((error as { cause?: unknown }).cause)));
});

test("RequestReview: a round that has a review returns its reviewer; a not-run mandatory check never reaches review", async () => {
	const taskId = await seedTask(80, [], false);
	const [implementer, reviewer] = [id(81), id(82)];
	await admin.insert(agents).values([{ id: implementer, name: "impl80", provider: "alpha", enabled: true }, { id: reviewer, name: "rev80", provider: "beta", enabled: true, capabilities: reviewerRoles }]);
	await admin.insert(taskRuns).values([
		{ id: id(83), taskId, attemptNumber: 1, role: "implementer", agentId: implementer, status: "finished" },
		{ id: id(84), taskId, attemptNumber: 2, role: "reviewer", agentId: reviewer, status: "finished" },
	]);
	await control.insert(taskReviews).values({ id: id(85), taskId, runId: id(84), reviewerId: reviewer, round: 1, verdict: "pass", findings: [] });
	const ok = [{ name: "tests", mandatory: true, status: "passed" as const }];
	const replay = await RequestReview(control, { taskId, round: 1, checks: ok, repairAttempted: false });
	assert.equal(replay.kind === "reviewer" ? replay.existingReviewId : null, id(85));
	const notRun = [{ name: "tests", mandatory: true, status: "not_run" as const }];
	assert.equal((await RequestReview(control, { taskId, round: 2, checks: notRun, repairAttempted: false })).kind, "repair");
	assert.equal((await RequestReview(control, { taskId, round: 2, checks: notRun, repairAttempted: true })).kind, "blocked");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { allTimeoutKeys, createActivityCatalog, settingKey } from "../control/activity-catalog.ts";
import { gateMandatoryChecks, pickReviewer } from "../control/activities/request-review.ts";
import { childId, decideChild, limitsOf, type ChildContext, type ChildLimits } from "../control/activities/create-child-tasks.ts";

const agent = (id: string, provider: string | null, enabled = true, roles: readonly string[] = ["reviewer"]) => ({ id, provider, enabled, roles });

test("pickReviewer never picks the implementer's provider or id (D20 review-provider)", () => {
	const implementers = [agent("a1", "alpha")];
	const choice = pickReviewer([agent("a1", "alpha"), agent("a2", "alpha"), agent("b1", "beta")], implementers);
	assert.deepEqual(choice, { kind: "reviewer", agentId: "b1", provider: "beta" });
});

test("pickReviewer reports none when only the same provider, a disabled agent or an unknown provider is left", () => {
	const implementers = [agent("a1", "alpha")];
	const choice = pickReviewer([agent("a2", "alpha"), agent("b1", "beta", false), agent("c1", null)], implementers);
	assert.deepEqual(choice, { kind: "none", reason: "no_other_provider" });
});

test("pickReviewer is deterministic: the lowest id of the eligible agents", () => {
	const choice = pickReviewer([agent("z", "beta"), agent("m", "gamma")], [agent("a1", "alpha")]);
	assert.equal(choice.kind === "reviewer" ? choice.agentId : null, "m");
});

test("pickReviewer needs the reviewer role: a planner of another provider reviews only when its roles list reviewer (temporal.md D20)", () => {
	const implementers = [agent("a1", "alpha")];
	const planner = (roles: readonly string[]) => agent("b0", "beta", true, roles);
	assert.deepEqual(pickReviewer([planner(["planner"])], implementers), { kind: "none", reason: "no_other_provider" });
	assert.deepEqual(pickReviewer([{ id: "b0", provider: "beta", enabled: true }], implementers), { kind: "none", reason: "no_other_provider" });
	assert.deepEqual(pickReviewer([planner(["planner", "reviewer"])], implementers), { kind: "reviewer", agentId: "b0", provider: "beta" });
	assert.equal(pickReviewer([planner(["planner"]), agent("b9", "beta")], implementers).kind === "reviewer" ? "ok" : "none", "ok");
});

test("gateMandatoryChecks: a not-run mandatory check is not a pass (check-not-run, D26)", () => {
	const checks = [{ name: "tests", mandatory: true, status: "not_run" as const }, { name: "lint", mandatory: true, status: "passed" as const }];
	assert.deepEqual(gateMandatoryChecks(checks, false), { kind: "repair", names: ["tests"] });
	assert.deepEqual(gateMandatoryChecks(checks, true), { kind: "blocked", blockKind: "check_environment", handler: "chief_engineer", names: ["tests"] });
});

test("gateMandatoryChecks: failed beats not_run, optional checks are ignored, all passed proceeds", () => {
	assert.equal(gateMandatoryChecks([{ name: "a", mandatory: true, status: "failed" }, { name: "b", mandatory: true, status: "not_run" }], false).kind, "failed");
	assert.equal(gateMandatoryChecks([{ name: "a", mandatory: false, status: "not_run" }], true).kind, "proceed");
	assert.equal(gateMandatoryChecks([{ name: "a", mandatory: true, status: "passed" }], false).kind, "proceed");
});

const limits: ChildLimits = { maxDepth: 2, maxChildren: 2, maxTokens: 1000, maxCost: 10 };
const context = (over: Partial<ChildContext> = {}): ChildContext => ({ parentDepth: 0, existingChildren: 0, spent: { tokens: 0, cost: 0 }, criteriaIds: new Set(["c1", "c2"]), ...over });

test("decideChild accepts a proposal inside every limit", () => {
	assert.deepEqual(decideChild(limits, context(), ["c1"]), { inside: true });
});

test("decideChild leaves a proposal open for each broken rule", () => {
	assert.deepEqual(decideChild(limits, context(), []), { inside: false, reason: "covers_empty" });
	assert.deepEqual(decideChild(limits, context(), ["c1", "x"]), { inside: false, reason: "covers_unknown" });
	assert.deepEqual(decideChild(limits, context({ parentDepth: 2 }), ["c1"]), { inside: false, reason: "depth" });
	assert.deepEqual(decideChild(limits, context({ existingChildren: 2 }), ["c1"]), { inside: false, reason: "children" });
	assert.deepEqual(decideChild(limits, context({ spent: { tokens: 1000, cost: 0 } }), ["c1"]), { inside: false, reason: "budget" });
	assert.deepEqual(decideChild(limits, context({ spent: { tokens: 0, cost: 10 } }), ["c1"]), { inside: false, reason: "budget" });
});

test("decideChild refuses the budget when the spend is unmeasured (a run without the usage_metrics keys)", () => {
	assert.deepEqual(decideChild(limits, context({ spent: null }), ["c1"]), { inside: false, reason: "budget_unmeasured" });
});

test("decideChild: a limit the policy leaves unset cannot prove the proposal is inside", () => {
	assert.deepEqual(decideChild({ ...limits, maxDepth: null }, context(), ["c1"]), { inside: false, reason: "limit_unset" });
	assert.deepEqual(decideChild(limitsOf(undefined), context(), ["c1"]), { inside: false, reason: "limit_unset" });
});

test("childId is stable per (parent, proposal, part) and differs between them", () => {
	assert.equal(childId("p", "q", "task"), childId("p", "q", "task"));
	assert.notEqual(childId("p", "q", "task"), childId("p", "q", "revision"));
	assert.notEqual(childId("p", "q", "task"), childId("p", "r", "task"));
	assert.match(childId("p", "q", "task"), /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("the three local activities take their timeouts from settings and throw when one is missing", () => {
	const names = ["NotifyUser", "CreateChildTasks", "RequestReview"] as const;
	const snapshot: Record<string, unknown> = {};
	for (const key of allTimeoutKeys()) snapshot[key] = 7;
	for (const name of names) snapshot[settingKey(name, "S")] = 11;
	const catalog = createActivityCatalog(snapshot);
	for (const name of names) {
		assert.ok(catalog.localNames().includes(name));
		assert.equal(catalog.timeouts(name).S, 11);
		assert.equal(catalog.timeouts(name).C, 7);
	}
	delete snapshot[settingKey("RequestReview", "C")];
	assert.throws(() => createActivityCatalog(snapshot).timeouts("RequestReview"));
});

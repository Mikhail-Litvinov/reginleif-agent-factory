import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { blockKinds } from "../contracts/states.ts";
import { ACTIVITIES, allTimeoutKeys } from "../control/activity-catalog.ts";
import { ChooseBlockHandler, goesThroughQuestionGate } from "../control/activities/block-handler.ts";
import { createCaptureRegulationVersion } from "../control/activities/capture-regulation.ts";
import { createQuestionGate } from "../control/activities/question-gate.ts";
import { createRecordPrecedent, precedentCases, precedentId, precedentKey } from "../control/activities/record-precedent.ts";

// Fixture values, not production defaults: the timeout setting registry.gateTimeoutMs and arbitrary ids.
const gateTimeoutMs = 40;
const actor = { tokenId: "token", sessionRef: "session" };
const inquiry = { id: "inquiry", number: 7, tokenId: "token", sessionRef: "session", runId: null, projectId: null };
const record = (id: string) => ({ id, version: 1 });
const hit = (id: string) => ({ record: record(id), score: 1, ranking: "fulltext" as const, matchedFields: [] });

function gateFixture(search: (input: any) => Promise<any>, timer?: any) {
	const results: any[] = [];
	const records = new Map<string, any>();
	const events: any[] = [];
	const reads: string[][] = [];
	const repo: any = {
		settings: { snapshot: async (keys: string[]) => { reads.push(keys); return { "registry.gateTimeoutMs": gateTimeoutMs }; } },
		registry: {
			inquiries: { get: async (id: string) => id === inquiry.id ? inquiry : undefined },
			results: { forInquiry: async () => results, create: async (r: any) => { results.push(r); return r; } },
			records: { get: async (id: string) => records.get(id) },
		},
	};
	const gate = createQuestionGate({ repo, search: search as any, persistEvent: async event => { events.push(event); }, ...(timer ? { timer } : {}) });
	return { gate, results, records, events, reads };
}
const input = (over: Record<string, unknown> = {}) => ({ taskId: "task", runId: "run", kind: "agent_question" as const, actor, inquiryId: inquiry.id, question: "Real question", ...over });
const noTimer = { set: () => 1, clear: () => {} };

describe("registry-first: the question gate", () => {
	it("gates only agent_question and scope raised by a question", () => {
		for (const kind of blockKinds) {
			assert.equal(goesThroughQuestionGate(kind), kind === "agent_question", kind);
			assert.equal(goesThroughQuestionGate(kind, true), kind === "agent_question" || kind === "scope", kind);
		}
	});

	it("does not touch the registry for other blocks", async () => {
		const f = gateFixture(async () => { assert.fail("search must not run"); });
		assert.deepEqual(await f.gate(input({ kind: "dependency" })), { gated: false });
		assert.deepEqual(await f.gate(input({ kind: "scope" })), { gated: false });
		assert.deepEqual(f.reads, []);
	});

	it("holds the question while a found record has no verdict, searching the real question", async () => {
		const queries: string[] = [];
		const f = gateFixture(async (query) => { queries.push(query.query); return { items: [hit("r")], degraded: false }; }, noTimer);
		f.records.set("r", record("r"));
		const answer = await f.gate(input({ question: "Different wording", kind: "scope", raisedByQuestion: true }));
		assert.deepEqual(answer, { gated: true, pass: false, records: [record("r")] });
		assert.deepEqual(queries, ["Different wording"]);
		assert.deepEqual(f.events, []);
		assert.deepEqual(f.reads, [["registry.gateTimeoutMs"]]);
	});

	it("passes once every found record has a verdict other than open or applies", async () => {
		const f = gateFixture(async () => ({ items: [], degraded: false }), noTimer);
		f.records.set("r", record("r"));
		f.results.push({ recordId: "r", verdict: "not_applicable" });
		assert.deepEqual(await f.gate(input()), { gated: true, pass: true, failedOpen: false });
		assert.deepEqual(f.events, []);
	});
});

describe("registry-fail-open: the question gate", () => {
	it("passes after the gate timer fires and records the fail-open locally, once per retry", async () => {
		const timer = { set: (fn: () => void, ms: number) => { assert.equal(ms, gateTimeoutMs); queueMicrotask(fn); return 1; }, clear: () => {} };
		const f = gateFixture(() => new Promise(() => {}), timer);
		const first = await f.gate(input());
		assert.deepEqual(first, { gated: true, pass: true, failedOpen: true });
		await f.gate(input());
		assert.equal(f.events.length, 2);
		// The same attempt repeated writes the same row: same id and dedupe key.
		assert.equal(f.events[0].id, f.events[1].id);
		assert.equal(f.events[0].dedupeKey, "registry-fail-open:inquiry:timeout");
		assert.equal(f.events[0].eventType, "registry_fail_open");
		assert.deepEqual(f.events[0].payload, { inquiryId: "inquiry", reason: "timeout", timeoutMs: gateTimeoutMs });
		assert.equal(f.events[0].taskId, "task");
		assert.equal(f.events[0].runId, "run");
	});

	it("passes and records unavailable when the search is down", async () => {
		const f = gateFixture(async () => { throw new Error("offline"); }, noTimer);
		assert.deepEqual(await f.gate(input()), { gated: true, pass: true, failedOpen: true });
		assert.equal(f.events[0].payload.reason, "unavailable");
		assert.equal(f.events[0].dedupeKey, "registry-fail-open:inquiry:unavailable");
	});

	it("rejects a missing timeout setting instead of guessing", async () => {
		const gate = createQuestionGate({ repo: { settings: { snapshot: async () => ({}) }, registry: {} } as any, search: (async () => ({})) as any, persistEvent: async () => {} });
		await assert.rejects(gate(input()), RangeError);
	});
});

describe("block-owner-load: ChooseBlockHandler", () => {
	it("tells the owner only for owner blocks", () => {
		for (const kind of blockKinds) {
			const answer = ChooseBlockHandler({ kind, engineerAvailable: true });
			assert.equal(answer.notifyOwner, answer.handler === "owner", kind);
			assert.equal(answer.waiting, false, kind);
		}
		assert.deepEqual(ChooseBlockHandler({ kind: "scope", engineerAvailable: true }), { handler: "owner", notifyOwner: true, waiting: false, viaGate: false });
		assert.equal(ChooseBlockHandler({ kind: "agent_question", engineerAvailable: false }).viaGate, true);
		assert.equal(ChooseBlockHandler({ kind: "scope", raisedByQuestion: true, engineerAvailable: true }).viaGate, true);
	});

	it("usage_limit goes to the owner only when no enabled agent can run", () => {
		assert.equal(ChooseBlockHandler({ kind: "usage_limit", engineerAvailable: true }).handler, "chief_engineer");
		assert.equal(ChooseBlockHandler({ kind: "usage_limit", cause: { noEnabledAgentCanRun: true }, engineerAvailable: true }).notifyOwner, true);
	});

	it("a block whose engineer is unavailable waits and tells nobody", () => {
		const answer = ChooseBlockHandler({ kind: "dependency", engineerAvailable: false });
		assert.deepEqual(answer, { handler: "chief_engineer", notifyOwner: false, waiting: true, viaGate: false });
		// An owner block never waits for the engineer, whatever the engineer's state.
		assert.equal(ChooseBlockHandler({ kind: "dependency", cause: { needsOwner: true }, engineerAvailable: false }).waiting, false);
	});
});

describe("registry-authority: RecordPrecedent", () => {
	const base = { taskId: "t1", runId: "r1", case: "dispute" as const, scope: { type: "global" as const }, problem: "p", decision: "d" };
	const fixture = () => {
		const rows = new Map<string, any>();
		const calls: any[] = [];
		const service = { createRecord: async (actorArg: any, row: any) => { calls.push({ actor: actorArg, row }); rows.set(row.id, row); return row; } };
		return { rows, calls, run: createRecordPrecedent({ service: service as any, records: { get: async (id: string) => rows.get(id) } as any }) };
	};

	it("writes an agent draft precedent through the service, never an active or owner record", async () => {
		const f = fixture();
		const row = await f.run(base);
		assert.deepEqual(f.calls[0].actor, { type: "agent", id: "r1", runId: "r1" });
		assert.equal(row.kind, "precedent");
		assert.equal(row.authority, "agent");
		assert.equal(row.status, "draft");
		assert.equal(row.source, "agent_proposal");
		assert.equal(row.sourceRef, "t1:r1:dispute");
		assert.equal((row.evidence as { idempotencyKey: string }).idempotencyKey, "t1:r1:dispute");
		assert.equal(row.id, precedentId(precedentKey(base)));
	});

	it("is idempotent by task id + run id + case", async () => {
		const f = fixture();
		const a = await f.run(base);
		const b = await f.run({ ...base, decision: "changed" });
		assert.equal(a.id, b.id);
		assert.equal(f.calls.length, 1);
		const ids = new Set(precedentCases.map(c => precedentId(precedentKey({ ...base, case: c }))));
		assert.equal(ids.size, precedentCases.length);
		assert.notEqual(precedentId(precedentKey({ ...base, runId: "r2" })), a.id);
	});

	it("returns the row a concurrent attempt wrote when the insert fails", async () => {
		const rows = new Map<string, any>();
		const service = { createRecord: async (_a: any, row: any) => { rows.set(row.id, row); throw new Error("duplicate"); } };
		const run = createRecordPrecedent({ service: service as any, records: { get: async (id: string) => rows.get(id) } as any });
		assert.equal((await run(base)).id, precedentId(precedentKey(base)));
	});

	it("rethrows when the insert fails and no row exists", async () => {
		const run = createRecordPrecedent({ service: { createRecord: async () => { throw new Error("refused"); } } as any, records: { get: async () => undefined } as any });
		await assert.rejects(run(base), /refused/);
	});

	it("a fact keeps the agent draft shape and a project scope sets the project", async () => {
		const f = fixture();
		const row = await f.run({ ...base, kind: "fact", scope: { type: "project", projectId: "p1" } });
		assert.equal(row.kind, "fact");
		assert.equal(row.scopeType, "project");
		assert.equal(row.projectId, "p1");
	});

	it("rejects an unknown case", async () => {
		await assert.rejects(fixture().run({ ...base, case: "other" as any }), RangeError);
	});
});

describe("registry-capture: CaptureRegulationVersion", () => {
	const fixture = (active: { id: string } | undefined, run: { regulationVersionId: string | null } | undefined, updated = 1) => {
		const sets: any[] = [];
		const db = { update: () => ({ set: (values: any) => { sets.push(values); return { where: () => ({ returning: async () => Array.from({ length: updated }, () => ({ id: "run" })) }) }; } }) };
		let current = run;
		return { sets, capture: createCaptureRegulationVersion({ repo: { registry: { regulations: { active: async () => active } } } as any, db, getRun: async () => current }), set: (r: any) => { current = r; } };
	};

	it("stores the active version on the run", async () => {
		const f = fixture({ id: "v1" }, { regulationVersionId: null });
		assert.deepEqual(await f.capture({ runId: "run" }), { captured: true, regulationVersionId: "v1", alreadySet: false });
		assert.deepEqual(f.sets, [{ regulationVersionId: "v1" }]);
	});

	it("never overwrites a stored version", async () => {
		const f = fixture({ id: "v2" }, { regulationVersionId: "v1" });
		assert.deepEqual(await f.capture({ runId: "run" }), { captured: true, regulationVersionId: "v1", alreadySet: true });
		assert.deepEqual(f.sets, []);
	});

	it("keeps NULL and says so when no version is active", async () => {
		const f = fixture(undefined, { regulationVersionId: null });
		assert.deepEqual(await f.capture({ runId: "run" }), { captured: false, reason: "no_active_regulation" });
		assert.deepEqual(f.sets, []);
	});

	it("returns the stored value after losing a race", async () => {
		const f = fixture({ id: "v2" }, { regulationVersionId: null }, 0);
		const pending = f.capture({ runId: "run" });
		f.set({ regulationVersionId: "v1" });
		assert.deepEqual(await pending, { captured: true, regulationVersionId: "v1", alreadySet: true });
	});

	it("rejects a missing run", async () => {
		await assert.rejects(fixture({ id: "v1" }, undefined).capture({ runId: "run" }), RangeError);
	});
});

describe("activity catalog registration", () => {
	it("registers the three activities as local and requires their timeout settings", () => {
		for (const name of ["RecordPrecedent", "AskQuestionGate", "ChooseBlockHandler", "CaptureRegulationVersion"] as const) assert.equal(ACTIVITIES[name].place, "local");
		assert.ok(allTimeoutKeys().includes("act.AskQuestionGate.S"));
		assert.ok(allTimeoutKeys().includes("act.ChooseBlockHandler.S"));
		assert.ok(!allTimeoutKeys().includes("act.ChooseBlockHandler.C"));
	});
});

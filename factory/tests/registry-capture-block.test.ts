// Package 53 on the server path: the activities are called the way a workflow calls them, against a real database.
// Roles: the question gate, RecordPrecedent, CaptureRegulationVersion and the fail-open event run as af_control (the Control
// Worker's role). The gate attaches found records to the inquiry (registry_inquiry_results), which migration 0010 grants to
// af_control with a trigger guard; setup and the inquiry service calls of the API side stay on af_api.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createCaptureRegulationVersion } from "../control/activities/capture-regulation.ts";
import { createQuestionGate } from "../control/activities/question-gate.ts";
import { createRecordPrecedent, precedentId, precedentKey } from "../control/activities/record-precedent.ts";
import { migrate } from "../db/migrate.ts";
import { createRepo } from "../db/repo/index.ts";
import { taskRuns } from "../db/schema/runs.ts";
import { applicableRecords, compareAuthority, createRegistryService } from "../registry/service.ts";
import { createRegistrySearch } from "../registry/search.ts";
import { connectBench, databaseBench } from "./database-bench.ts";

const bench = databaseBench(import.meta.url);
let migrator: ReturnType<typeof postgres>;
let api: ReturnType<typeof postgres>;
let control: ReturnType<typeof postgres>;
let apiRepo: ReturnType<typeof createRepo>;
let controlRepo: ReturnType<typeof createRepo>;
let controlDb: ReturnType<typeof drizzle>;

// Fixture value for registry.gateTimeoutMs, not a production default.
const gateTimeoutMs = 100;
const task = randomUUID();
const run = randomUUID();
const otherRun = randomUUID();
const agentSession = { tokenId: randomUUID(), sessionRef: "registry-capture-block" };
const ruleId = randomUUID();
const ownerRecordId = randomUUID();
const regulationOne = randomUUID();
const regulationTwo = randomUUID();

before(async () => {
	const b = await bench;
	await migrate({ url: b.migratorUrl });
	migrator = connectBench(b.migratorUrl);
	api = connectBench(b.apiUrl);
	control = connectBench(b.controlUrl);
	apiRepo = createRepo(drizzle(api));
	controlDb = drizzle(control);
	controlRepo = createRepo(controlDb);
	await migrator`INSERT INTO tasks (id) VALUES (${task})`;
	await migrator`INSERT INTO task_runs (id, task_id, role) VALUES (${run}, ${task}, 'implementer'), (${otherRun}, ${task}, 'implementer')`;
	await apiRepo.tokens.create({ id: agentSession.tokenId, role: "registry", sessionRef: agentSession.sessionRef, prefix: agentSession.sessionRef, tokenHash: agentSession.sessionRef });
	await apiRepo.settings.set("registry.gateTimeoutMs", gateTimeoutMs, null);
	await apiRepo.registry.records.create({ id: ownerRecordId, kind: "decision", authority: "owner", status: "draft", scopeType: "global", category: "general", problem: "Amber lantern illuminates harbor", decision: "Use lanterns", reuse: "standing", source: "import", createdBy: {} });
	await apiRepo.registry.records.changeStatus(ownerRecordId, "active", new Date(), {});
});
after(async () => { await Promise.all([migrator?.end(), api?.end(), control?.end()]); });

const searchOf = () => createRegistrySearch(controlRepo,() => undefined);
const agentActor = { tokenId: agentSession.tokenId, sessionRef: agentSession.sessionRef, runId: run };
const persistEvent = (event: Parameters<typeof controlRepo.taskEvents.persist>[0]) => controlRepo.taskEvents.persist(event);

describe("registry-first (server path)", () => {
	it("an agent_question waits for the registry verdict, then passes once the record is not applicable", async () => {
		const service = createRegistryService(apiRepo);
		const actor = { type: "agent" as const, id: randomUUID(), ...agentSession, runId: run };
		const owner = (await apiRepo.registry.records.get(ownerRecordId))!;
		const opened = await service.openInquiry(actor, { id: randomUUID(), tokenId: agentSession.tokenId, sessionRef: agentSession.sessionRef, runId: run, problem: "Other words", category: "general" }, [
			{ id: randomUUID(), recordId: owner.id, recordVersion: owner.version, foundBy: "inquiry", ranking: "fulltext", score: "1", matchedFields: ["problem"] },
		]);
		const gate = createQuestionGate({ repo: controlRepo, search: searchOf(), persistEvent, timer: { set: () => 1, clear: () => {} } });
		const blocked = await gate({ taskId: task, runId: run, kind: "agent_question", actor: agentActor, inquiryId: opened.inquiry.id, question: "Amber lantern" });
		assert.equal(blocked.gated, true);
		assert.equal(blocked.gated && blocked.pass, false);
		await service.setVerdict(actor, opened.inquiry.id, ownerRecordId, { verdict: "not_applicable", difference: "Different situation" });
		const passed = await gate({ taskId: task, runId: run, kind: "agent_question", actor: agentActor, inquiryId: opened.inquiry.id, question: "Amber lantern" });
		assert.deepEqual(passed, { gated: true, pass: true, failedOpen: false });
	});

	it("a block that is not a question never touches the registry", async () => {
		const gate = createQuestionGate({ repo: controlRepo, search: (() => { throw new Error("the registry must not be asked"); }) as any, persistEvent });
		assert.deepEqual(await gate({ taskId: task, runId: run, kind: "execution", actor: agentActor, inquiryId: randomUUID(), question: "x" }), { gated: false });
	});
});

describe("registry-fail-open (server path)", () => {
	it("the gate passes after the injected timer fires and records exactly one local event, also on a retry", async () => {
		const service = createRegistryService(apiRepo);
		const actor = { type: "agent" as const, id: randomUUID(), ...agentSession, runId: run };
		const opened = await service.openInquiry(actor, { id: randomUUID(), tokenId: agentSession.tokenId, sessionRef: agentSession.sessionRef, runId: run, problem: "Slow question", category: "general" }, []);
		const call = () => {
			// The gate reads its settings before it arms the timer, so the test fires the timer only once it is armed.
			let armed!: (callback: () => void) => void;
			const timerArmed = new Promise<() => void>(resolve => { armed = resolve; });
			const gate = createQuestionGate({
				repo: controlRepo, search: () => new Promise(() => {}), persistEvent,
				timer: { set: (callback, ms) => { assert.equal(ms, gateTimeoutMs); armed(callback); return 1; }, clear: () => {} },
			});
			const result = gate({ taskId: task, runId: run, kind: "scope", raisedByQuestion: true, actor: agentActor, inquiryId: opened.inquiry.id, question: "Slow question" });
			return { result, fire: async () => (await timerArmed)() };
		};
		const first = call();
		await first.fire();
		assert.deepEqual(await first.result, { gated: true, pass: true, failedOpen: true });
		const retry = call();
		await retry.fire();
		assert.deepEqual(await retry.result, { gated: true, pass: true, failedOpen: true });
		const rows = await migrator`SELECT payload FROM task_events WHERE task_id = ${task} AND event_type = 'registry_fail_open' AND payload->>'inquiryId' = ${opened.inquiry.id}`;
		assert.equal(rows.length, 1);
		assert.deepEqual(rows[0]!.payload, { inquiryId: opened.inquiry.id, reason: "timeout", timeoutMs: gateTimeoutMs });
	});
});

describe("registry-authority (server path)", () => {
	const record = () => createRecordPrecedent({ service: createRegistryService(controlRepo), records: controlRepo.registry.records });
	const input = (over: Record<string, unknown> = {}) => ({ taskId: task, runId: run, case: "dispute" as const, scope: { type: "global" as const }, problem: "Which lamp for the harbor?", decision: "Amber lamps", ...over });

	it("writes an agent draft precedent as af_control and a retry returns the same row", async () => {
		const first = await record()(input());
		assert.equal(first.id, precedentId(precedentKey({ taskId: task, runId: run, case: "dispute" })));
		assert.equal(first.kind, "precedent");
		assert.equal(first.authority, "agent");
		assert.equal(first.status, "draft");
		assert.equal(first.source, "agent_proposal");
		const again = await record()(input({ decision: "A different text on retry" }));
		assert.equal(again.id, first.id);
		assert.equal(again.decision, "Amber lamps");
		const other = await record()(input({ case: "block" }));
		assert.notEqual(other.id, first.id);
		assert.equal((await migrator`SELECT 1 FROM registry_records WHERE source_ref = ${precedentKey({ taskId: task, runId: run, case: "dispute" })}`).length, 1);
	});

	it("never produces an owner or active record, and a precedent never outranks a rule or an owner decision", async () => {
		const service = createRegistryService(controlRepo);
		const actor = { type: "agent" as const, id: run, runId: run };
		const base = { id: randomUUID(), kind: "precedent", scopeType: "global", category: null, problem: "p", decision: "d", reuse: "standing", source: "agent_proposal", evidence: { x: 1 } };
		await assert.rejects(service.createRecord(actor, { ...base, authority: "owner", status: "draft" } as any), { reason: "forbidden" });
		await assert.rejects(service.createRecord(actor, { ...base, id: randomUUID(), authority: "agent", status: "active" } as any));
		await assert.rejects(service.createRecord(actor, { ...base, id: randomUUID(), kind: "fact", authority: "agent", status: "draft", evidence: {} } as any), { reason: "evidence_missing" });
		const precedent = (await controlRepo.registry.records.get(precedentId(precedentKey({ taskId: task, runId: run, case: "dispute" }))))!;
		const owner = (await apiRepo.registry.records.get(ownerRecordId))!;
		assert.ok(compareAuthority(precedent as any, owner as any, []) < 0);
		assert.ok(compareAuthority(precedent as any, { ...owner, kind: "rule" } as any, []) < 0);
		// A draft is advice nobody sees yet: it is not applicable until someone with the right activates it.
		assert.deepEqual(applicableRecords([precedent as any], { type: "global" } as any), []);
	});
});

describe("registry-capture (server path)", () => {
	const capture = () => createCaptureRegulationVersion({
		repo: controlRepo, db: controlDb as any,
		getRun: async (id) => (await controlDb.select({ regulationVersionId: taskRuns.regulationVersionId }).from(taskRuns).where(eq(taskRuns.id, id)).limit(1))[0],
	});
	const activate = async (id: string) => {
		await migrator`INSERT INTO regulation_versions (id, status) VALUES (${id}, 'draft')`;
		await migrator`UPDATE regulation_versions SET status = 'active' WHERE id = ${id}`;
	};

	it("with no active regulation the run keeps NULL and the result says so", async () => {
		assert.deepEqual(await capture()({ runId: run }), { captured: false, reason: "no_active_regulation" });
		assert.equal((await migrator`SELECT regulation_version_id FROM task_runs WHERE id = ${run}`)[0]!.regulation_version_id, null);
	});

	it("stores the active version at the run's start, once; a later version and a retry never overwrite it", async () => {
		await activate(regulationOne);
		assert.deepEqual(await capture()({ runId: run }), { captured: true, regulationVersionId: regulationOne, alreadySet: false });
		await activate(regulationTwo);
		assert.deepEqual(await capture()({ runId: run }), { captured: true, regulationVersionId: regulationOne, alreadySet: true });
		assert.equal((await migrator`SELECT regulation_version_id FROM task_runs WHERE id = ${run}`)[0]!.regulation_version_id, regulationOne);
		// A run that starts after the change gets the new version.
		assert.deepEqual(await capture()({ runId: otherRun }), { captured: true, regulationVersionId: regulationTwo, alreadySet: false });
	});

	it("a missing run is an error, not a silent no-op", async () => {
		await assert.rejects(capture()({ runId: randomUUID() }), RangeError);
	});
});

describe("af_control grants of migration 0010", () => {
	it("attaches a gate-found record without a verdict, and nothing more", async () => {
		const service = createRegistryService(apiRepo);
		const actor = { type: "agent" as const, id: randomUUID(), ...agentSession, runId: run };
		const opened = await service.openInquiry(actor, { id: randomUUID(), tokenId: agentSession.tokenId, sessionRef: agentSession.sessionRef, runId: run, problem: "Grant boundary", category: "general" }, []);
		const inquiry = opened.inquiry.id;
		const resultId = randomUUID();
		await control`INSERT INTO registry_inquiry_results (id, inquiry_id, record_id, record_version, found_by, ranking, score) VALUES (${resultId}, ${inquiry}, ${ownerRecordId}, 1, 'gate', 'fulltext', 1)`;
		// No verdict, no found_by other than the gate: the verdict stays af_api's.
		await assert.rejects(control`INSERT INTO registry_inquiry_results (id, inquiry_id, record_id, record_version, found_by, ranking, score) VALUES (${randomUUID()}, ${inquiry}, ${ownerRecordId}, 1, 'inquiry', 'fulltext', 1)`, /gate-found records/i);
		await assert.rejects(control`INSERT INTO registry_inquiry_results (id, inquiry_id, record_id, record_version, found_by, ranking, score, verdict) VALUES (${randomUUID()}, ${inquiry}, ${ownerRecordId}, 1, 'gate', 'fulltext', 1, 'applies')`, /gate-found records/i);
		// No update of any column, no delete, no insert into the inquiry itself.
		await assert.rejects(control`UPDATE registry_inquiry_results SET verdict = 'applies' WHERE id = ${resultId}`, /permission denied/i);
		await assert.rejects(control`UPDATE registry_inquiry_results SET ranking = 'trigram' WHERE id = ${resultId}`, /permission denied/i);
		await assert.rejects(control`DELETE FROM registry_inquiry_results WHERE id = ${resultId}`, /permission denied/i);
		await assert.rejects(control`INSERT INTO registry_inquiries (id) VALUES (${randomUUID()})`, /permission denied/i);
		// af_api still sets the verdict on the row control attached.
		await service.setVerdict(actor, inquiry, ownerRecordId, { verdict: "not_applicable", difference: "Different situation" });
	});
});
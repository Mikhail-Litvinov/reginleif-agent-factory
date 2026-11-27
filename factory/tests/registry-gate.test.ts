import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, it } from "node:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { migrate } from "../db/migrate.ts";
import { createRepo } from "../db/repo/index.ts";
import { createRegistryService } from "../registry/service.ts";
import { createRegistrySearch } from "../registry/search.ts";
import { createRegistryGate } from "../registry/gate.ts";
import { connectBench, databaseBench } from "./database-bench.ts";

const bench = databaseBench(import.meta.url);
let client: ReturnType<typeof postgres>;
let repo: ReturnType<typeof createRepo>;
const actor = { type: "agent" as const, id: randomUUID(), tokenId: randomUUID(), sessionRef: "gate-bench" };
const recordId = randomUUID();
// Fixture value for registry.gateTimeoutMs, not a production default.
const timeoutMs = 100;
before(async () => {
	const b = await bench;
	await migrate({ url: b.migratorUrl });
	client = connectBench(b.migratorUrl);
	repo = createRepo(drizzle(client));
	await repo.tokens.create({ id: actor.tokenId, role: "registry", sessionRef: actor.sessionRef, prefix: actor.sessionRef, tokenHash: actor.sessionRef });
	await repo.settings.set("registry.gateTimeoutMs", timeoutMs, null);
	await repo.registry.records.create({ id: recordId, kind: "decision", authority: "owner", status: "draft", scopeType: "global", category: "general", problem: "Amber lantern illuminates harbor", decision: "Use lanterns", reuse: "standing", source: "import", createdBy: {} });
	await repo.registry.records.changeStatus(recordId, "active", new Date(), {});
});
after(async () => { await client?.end(); });

it("registry-first: the fake question hook waits for the gate and only sends permitted questions", async () => {
	const service = createRegistryService(repo);
	const opened = await service.openInquiry(actor, { id: randomUUID(), tokenId: actor.tokenId, sessionRef: actor.sessionRef, problem: "Other words", category: "general" }, []);
	assert.ok(opened.inquiry.number);
	const settings = await repo.settings.snapshot(["registry.gateTimeoutMs"]);
	const gate = createRegistryGate(repo, createRegistrySearch(repo, () => undefined), { timeoutMs: settings["registry.gateTimeoutMs"] as number, timer: { set: () => 1, clear: () => {} }, recordFailOpen: () => assert.fail("unexpected fail-open") });
	const sent: string[] = [];
	const hook = async (inquiryId: string, question: string) => {
		const answer = await gate(actor, { inquiryId, question });
		if (answer.pass) sent.push(question);
		return answer;
	};
	assert.equal((await hook(randomUUID(), "Amber lantern")).pass, false);
	const first = await hook(opened.inquiry.id, "Amber lantern");
	assert.equal(first.pass, false);
	if (!first.pass) assert.equal(first.records[0]?.id, recordId);
	assert.deepEqual(sent, []);
	await service.setVerdict(actor, opened.inquiry.id, recordId, { verdict: "not_applicable", difference: "Different situation" });
	assert.equal((await hook(opened.inquiry.id, "Amber lantern")).pass, true);
	assert.deepEqual(sent, ["Amber lantern"]);
});

it("registry-fail-open: the fake hook sends after the injected gate timer fires", async () => {
	const service = createRegistryService(repo);
	const opened = await service.openInquiry(actor, { id: randomUUID(), tokenId: actor.tokenId, sessionRef: actor.sessionRef, problem: "Question", category: "general" }, []);
	const settings = await repo.settings.snapshot(["registry.gateTimeoutMs"]);
	let fire = () => {};
	const events: string[] = [];
	const gate = createRegistryGate(repo, () => new Promise(() => {}), { timeoutMs: settings["registry.gateTimeoutMs"] as number, timer: { set: (fn, ms) => { assert.equal(ms, timeoutMs); fire = fn; return 1; }, clear: () => {} }, recordFailOpen: () => events.push("fail-open") });
	const hook = gate(actor, { inquiryId: opened.inquiry.id, question: "Question" }).then(answer => { if (answer.pass) events.push("sent"); });
	assert.deepEqual(events, []);
	fire();
	await hook;
	assert.deepEqual(events, ["fail-open", "sent"]);
});

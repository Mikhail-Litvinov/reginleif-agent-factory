import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { migrate } from "../db/migrate.ts";
import { createRepo } from "../db/repo/index.ts";
import { RegistryRefusedError } from "../db/repo/registry.ts";
import { createRegistryService } from "../registry/service.ts";
import { connectBench, databaseBench } from "./database-bench.ts";

const bench = databaseBench(import.meta.url);
let client: ReturnType<typeof postgres>;
let repo: ReturnType<typeof createRepo>;
let service: ReturnType<typeof createRegistryService>;
before(async () => {
	const b = await bench;
	await migrate({ url: b.migratorUrl });
	client = connectBench(b.migratorUrl);
	repo = createRepo(drizzle(client));
	service = createRegistryService(repo);
});
after(async () => { await client?.end(); });
const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const owner = { type: "owner" as const, id: id(1) };
const agent = { type: "agent" as const, id: id(2), tokenId: id(3), runId: id(4) };
const draft = (n: number) => ({ id: id(n), kind: "decision", authority: "owner", status: "draft", scopeType: "global", category: "general", problem: "problem", decision: "decision", reuse: "standing", source: "import" });
const refused = (reason: string) => (e: unknown) => e instanceof RegistryRefusedError && e.reason === reason;

it("preserves the old record and link until activation and audits status changes", async () => {
	const old = await service.createRecord(owner, draft(10));
	await service.changeStatus(owner, old.id, "active");
	const replacement = await service.createSupersedingDraft(owner, old.id, id(12), draft(11));
	assert.equal((await repo.registry.records.get(old.id))?.status, "active");
	await service.changeStatus(owner, replacement.id, "active");
	assert.equal((await repo.registry.records.get(old.id))?.status, "superseded");
	assert.equal((await repo.registry.links.forRecord(old.id)).length, 1);
	assert.equal((await repo.registry.records.history(old.id)).length, 2);
	await service.changeStatus(owner, replacement.id, "revoked");
	assert.equal((await repo.registry.records.get(replacement.id))?.status, "revoked");
	assert.equal((await repo.registry.links.forRecord(replacement.id)).length, 1);
	await assert.rejects(repo.registry.records.updateContent(old.id, { problem: "replacement" }), RegistryRefusedError);
});

it("refuses an agent's owner authority, activation, links and permissions", async () => {
	await assert.rejects(service.createRecord(agent, draft(20)), refused("forbidden"));
	await assert.rejects(service.createRecord(agent, { ...draft(21), authority: "agent", status: "active" }), refused("forbidden"));
	await assert.rejects(service.createRecord(agent, { ...draft(22), authority: "agent", kind: "permission" }), refused("forbidden"));
	await assert.rejects(service.changeStatus(agent, id(10), "revoked"), refused("forbidden"));
	await assert.rejects(service.linkRecords(agent, { id: id(23), fromRecordId: id(10), toRecordId: id(11), linkType: "supersedes" }), refused("forbidden"));
	await assert.rejects(service.createSupersedingDraft(agent, id(10), id(26), { ...draft(27), authority: "agent" }), refused("forbidden"));
	await assert.rejects(service.createRecord(owner, { ...draft(24), kind: "permission", source: "poll_press" }), refused("permission_by_poll"));
	await assert.rejects(service.createRecord(owner, { ...draft(25), scopeType: "project" }), refused("registry_scope_required"));
	await assert.rejects(service.createRecord(agent, { ...draft(28), authority: "agent", source: "owner_button" }), refused("forbidden"));
	await assert.rejects(service.createRecord(owner, { ...draft(29), kind: "precedent" }), refused("forbidden"));
	await assert.rejects(service.createRecord(agent, { ...draft(33), authority: "agent", kind: "fact", source: "agent_proposal" }), refused("evidence_missing"));
	const rule = await service.createRecord(owner, { ...draft(34), kind: "rule" });
	await assert.rejects(service.changeStatus(owner, rule.id, "active"), refused("rule_needs_regulation"));
});

it("stores inquiry results and verdicts without changing records", async () => {
	const record = await service.createRecord(owner, draft(30));
	const registryActor = { type: "agent" as const, id: id(35), tokenId: id(36), sessionRef: "registry-test" };
	await repo.tokens.create({ id: registryActor.tokenId, role: "registry", sessionRef: registryActor.sessionRef, prefix: "registry-test", tokenHash: "registry-test" });
	const { inquiry, results } = await service.openInquiry(registryActor, { id: id(31), tokenId: registryActor.tokenId, sessionRef: registryActor.sessionRef, problem: "problem", category: "general" }, [
		{ id: id(32), recordId: record.id, recordVersion: 1, foundBy: "inquiry", ranking: "fulltext", score: "1", matchedFields: [] },
	]);
	assert.equal(inquiry.reuseIntent, "once");
	assert.equal(results.length, 1);
	await assert.rejects(service.setVerdict(agent, inquiry.id, record.id, { verdict: "applies" }), refused("forbidden"));
	await assert.rejects(service.setVerdict(owner, inquiry.id, record.id, { verdict: "applies" }), refused("forbidden"));
	await assert.rejects(service.setVerdict(registryActor, inquiry.id, record.id, { verdict: "conflict", difference: "different", conflictsWithId: id(99) }), refused("validation_failed"));
	assert.equal((await service.setVerdict(registryActor, inquiry.id, record.id, { verdict: "outdated", difference: "changed" })).verdict, "outdated");
	assert.equal((await repo.registry.records.get(record.id))?.status, "draft");
	await assert.rejects(service.setVerdict(registryActor, inquiry.id, record.id, { verdict: "applies" }), refused("validation_failed"));
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, it } from "node:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { migrate } from "../db/migrate.ts";
import { createRepo } from "../db/repo/index.ts";
import { createRegistryService } from "../registry/service.ts";
import { connectBench, databaseBench } from "./database-bench.ts";

const bench = databaseBench(import.meta.url);
let sql: ReturnType<typeof postgres>;
let api: ReturnType<typeof postgres>;
let repo: ReturnType<typeof createRepo>;
let service: ReturnType<typeof createRegistryService>;
const telegramUserId = 123n;
const owner = { type: "owner" as const, id: randomUUID() };
const agent = { type: "agent" as const, id: randomUUID(), tokenId: randomUUID(), sessionRef: "registry-service-2" };
const relay = { type: "relay" as const };
const confirmationSeconds = 60;
const clauseMaxBytes = 4096;
const now = new Date("2030-01-01T00:00:00Z");
const options = [{ key: "tabs", label: "Tabs" }, { key: "spaces", label: "Spaces" }];

before(async () => {
	const db = await bench;
	await migrate({ url: db.migratorUrl });
	sql = connectBench(db.migratorUrl);
	api = connectBench(db.apiUrl);
	repo = createRepo(drizzle(api));
	service = createRegistryService(repo, async (_input, registry) =>
		(await registry.records.list({ kind: "rule", status: "active" })).map(row => ({
			id: randomUUID(), recordId: row.id, recordVersion: row.version,
			foundBy: "inquiry", ranking: "fulltext", score: "1", matchedFields: ["decision"],
		})));
	await sql`INSERT INTO owners (id, telegram_user_id) VALUES (${owner.id}, ${telegramUserId.toString()})`;
	await sql`INSERT INTO settings (key, value) VALUES ('confirm.windowSeconds', ${sql.json(confirmationSeconds)}), ('registry.clauseMaxBytes', ${sql.json(clauseMaxBytes)}) ON CONFLICT (key) DO UPDATE SET value = excluded.value`;
	await repo.tokens.create({ id: agent.tokenId, role: "registry", sessionRef: agent.sessionRef, prefix: agent.sessionRef, tokenHash: agent.sessionRef });
});

after(async () => { await Promise.all([api?.end(), sql?.end()]); });

const globalDraft = (problem: string, decision: string) => ({
	id: randomUUID(), kind: "decision", authority: "owner", status: "draft", scopeType: "global",
	category: "general", problem, decision, reuse: "standing", source: "owner_button",
});

async function confirm(id: string) {
	const first = await service.requestRegulationConfirmation(owner, id, { channel: "client", now });
	return { confirm: `${first.id}.${first.nonce}`, channel: "client", now, confirmationId: first.id, expiresAt: first.expiresAt };
}

it("regulation-change: refusals preserve the draft and leave confirmation and audit untouched", async () => {
	const empty = await service.createRegulationDraft(agent, { id: randomUUID(), clauses: [] });
	await assert.rejects(service.activateRegulation(agent, empty.id), { reason: "forbidden" });
	await assert.rejects(service.requestRegulationConfirmation(agent, empty.id, { channel: "client", now }), { reason: "forbidden" });
	await assert.rejects(service.activateRegulation(owner, empty.id), { reason: "confirmation_required" });
	const first = await confirm(empty.id);
	await assert.rejects(service.activateRegulation(owner, empty.id, { ...first, channel: "telegram" }), { reason: "confirmation_invalid" });
	await assert.rejects(service.activateRegulation(owner, empty.id, { ...first, now: first.expiresAt }), { reason: "confirmation_invalid" });
	assert.equal((await repo.confirmations.get(first.confirmationId))?.usedAt, null);
	assert.equal((await repo.registry.regulations.get(empty.id))?.status, "draft");

	for (const decision of ["One press is enough", "Disable the sandbox profile", "Bypass the repository allowlist"]) {
		const rule = await service.createRecord(owner, { ...globalDraft(decision, decision), kind: "rule" });
		await assert.rejects(service.changeStatus(owner, rule.id, "active"), { reason: "rule_needs_regulation" });
		const version = await service.createRegulationDraft(owner, { id: randomUUID(), clauses: [rule.id] });
		assert.equal(version.conflictReport.guards.length, 1);
		const second = await confirm(version.id);
		await assert.rejects(service.activateRegulation(owner, version.id, second), { reason: "guard_conflict" });
		assert.equal((await repo.registry.regulations.get(version.id))?.status, "draft");
		assert.equal((await repo.registry.records.get(rule.id))?.status, "draft");
		assert.equal((await repo.confirmations.get(second.confirmationId))?.usedAt, null);
		assert.deepEqual(await repo.registry.regulations.history(version.id), []);
	}

	const problem = "How should we indent the manual?";
	const rule = await service.createRecord(owner, { ...globalDraft(problem, "Use tabs"), kind: "rule" });
	const conflict = await service.createRegulationDraft(owner, { id: randomUUID(), clauses: [rule.id] });
	const decision = await service.createRecord(owner, globalDraft(problem, "Use spaces"));
	await service.changeStatus(owner, decision.id, "active");
	const second = await confirm(conflict.id);
	await assert.rejects(service.activateRegulation(owner, conflict.id, second), { reason: "regulation_conflict", conflictsWith: [decision.id] });
	assert.equal((await repo.confirmations.get(second.confirmationId))?.usedAt, null);
	assert.deepEqual(await repo.registry.regulations.history(conflict.id), []);
	await service.changeStatus(owner, decision.id, "revoked");

	const oversized = await service.createRegulationDraft(owner, {
		id: randomUUID(), clauses: [{ record_id: rule.id, note: "é".repeat(clauseMaxBytes) }],
	});
	await assert.rejects(service.activateRegulation(owner, oversized.id, await confirm(oversized.id)), { reason: "regulation_too_large" });
	assert.equal((await repo.registry.regulations.get(oversized.id))?.status, "draft");
	assert.equal(await repo.registry.regulations.active(), undefined);
});

it("registry-history: a live session sees added and withdrawn clauses and inquiries use the new version", async () => {
	const oldRule = await service.createRecord(owner, { ...globalDraft("Indentation", "Use tabs"), kind: "rule" });
	const replacement = await service.createSupersedingDraft(owner, oldRule.id, randomUUID(), {
		...globalDraft("Indentation", "Use spaces"), kind: "rule",
	});
	const old = await service.createRegulationDraft(owner, { id: randomUUID(), clauses: [oldRule.id] });
	const oldConfirmation = await confirm(old.id);
	const activated = await service.activateRegulation(owner, old.id, oldConfirmation);
	assert.equal(activated.confirmationId, oldConfirmation.confirmationId);
	await assert.rejects(service.activateRegulation(owner, old.id, oldConfirmation), { reason: "confirmation_invalid" });
	const next = await service.createRegulationDraft(owner, { id: randomUUID(), clauses: [{ id: replacement.id }], basisVersionId: old.id });
	assert.deepEqual(next.conflictReport, { guards: [], records: [] });
	assert.equal((await repo.registry.records.get(oldRule.id))?.status, "active");
	assert.equal((await repo.registry.records.get(replacement.id))?.status, "draft");

	const inquiry = { tokenId: agent.tokenId, sessionRef: agent.sessionRef, problem: "Indentation", category: "formatting" };
	const before = await service.openInquiry(agent, { id: randomUUID(), ...inquiry });
	assert.equal(before.inquiry.regulationVersionId, old.id);
	assert.deepEqual(before.results.map(row => row.recordId), [oldRule.id]);
	assert.equal(await service.getRegulationUpdate(old.id, {}), null);
	const preview = await service.getRegulationDiff(next.id);
	assert.deepEqual(preview.changes.map(change => [change.clauseId, change.change]), [[oldRule.id, "removed"], [replacement.id, "added"]]);
	const replacementConfirmation = await confirm(next.id);
	await service.activateRegulation(owner, next.id, replacementConfirmation);
	// The live-session consumer asks before its next tool call, using the id it last delivered.
	const current = await service.getRegulationUpdate(old.id, {});
	assert.equal(current?.number, next.number);
	assert.equal(current?.changes.find(change => change.clauseId === replacement.id)?.after?.decision, "Use spaces");
	assert.equal(current?.changes.find(change => change.clauseId === oldRule.id)?.change, "removed");
	const after = await service.openInquiry(agent, { id: randomUUID(), ...inquiry, regulationVersionId: old.id });
	assert.equal(after.inquiry.regulationVersionId, next.id);
	assert.deepEqual(after.results.map(row => row.recordId), [replacement.id]);
	assert.deepEqual((await repo.registry.results.forInquiry(before.inquiry.id)).map(row => row.recordId), [oldRule.id]);
	assert.equal((await repo.registry.records.get(oldRule.id))?.status, "superseded");
	assert.equal((await repo.registry.records.get(oldRule.id))?.decision, "Use tabs");
	assert.equal((await repo.registry.regulations.get(old.id))?.status, "superseded");
	assert.equal((await repo.registry.regulations.history(old.id)).length, 2);
	assert.equal((await repo.registry.records.history(oldRule.id)).length, 2);
	assert.equal((await repo.registry.links.forRecord(oldRule.id))[0]?.toRecordId, oldRule.id);
	const supersession = await sql`SELECT actor_id, details->>'confirmation_id' AS confirmation_id FROM audit_log WHERE action = 'regulation.supersede' AND target_id = ${old.id}`;
	assert.deepEqual([...supersession], [{ actor_id: owner.id, confirmation_id: replacementConfirmation.confirmationId }]);

	const revokingOwner = { type: "owner" as const, id: randomUUID() };
	await sql`INSERT INTO owners (id) VALUES (${revokingOwner.id})`;
	await assert.rejects(service.revokeRegulation(revokingOwner, next.id), { reason: "confirmation_required" });
	const revocation = await service.requestRegulationConfirmation(revokingOwner, next.id, { channel: "client", now }, "revoke");
	await service.revokeRegulation(revokingOwner, next.id, { channel: "client", now, confirm: `${revocation.id}.${revocation.nonce}` });
	const audit = await sql`SELECT actor_id, details->>'confirmation_id' AS confirmation_id FROM audit_log WHERE action = 'regulation.revoke' AND target_id = ${next.id}`;
	assert.deepEqual([...audit], [{ actor_id: revokingOwner.id, confirmation_id: revocation.id }]);
	assert.equal((await repo.registry.records.get(replacement.id))?.status, "revoked");
	assert.equal((await repo.registry.records.history(replacement.id)).length, 2);
	assert.equal((await service.getRegulationUpdate(next.id, {}))?.changes[0]?.change, "removed");
	assert.equal((await repo.registry.links.forRecord(replacement.id)).length, 1);
	await assert.rejects(sql`UPDATE registry_records SET decision = 'changed' WHERE id = ${oldRule.id}`, /immutable/i);
	await assert.rejects(sql`DELETE FROM registry_records WHERE id = ${oldRule.id}`, /immutable/i);
	await assert.rejects(api`UPDATE registry_records SET decision = 'changed' WHERE id = ${oldRule.id}`, /permission denied/i);
	await assert.rejects(api`DELETE FROM registry_records WHERE id = ${oldRule.id}`, /permission denied/i);
});

it("registry-history: an offered Telegram answer atomically supersedes an outdated project decision and audits both", async () => {
	const projectId = randomUUID();
	await sql`INSERT INTO projects (id) VALUES (${projectId})`;
	const old = await service.createRecord(owner, {
		...globalDraft("Tabs or spaces?", "Tabs"), projectId, scopeType: "project", category: "formatting",
	});
	await service.changeStatus(owner, old.id, "active");
	const { inquiry } = await service.openInquiry(agent, {
		id: randomUUID(), tokenId: agent.tokenId, sessionRef: agent.sessionRef, projectId, category: "formatting", reuseIntent: "standing",
	}, [{ id: randomUUID(), recordId: old.id, recordVersion: old.version, foundBy: "inquiry", ranking: "fulltext", score: "1", matchedFields: ["decision"] }]);
	await service.setVerdict(agent, inquiry.id, old.id, { verdict: "outdated", difference: "Team changed indentation tools" });
	const input = { pollId: inquiry.id, telegramUserId, optionIndex: 1, pressId: randomUUID() };
	await assert.rejects(service.capturePoll(relay, input), { reason: "not_found" });
	const question = "Tabs or spaces?";
	assert.deepEqual(await service.registerPoll(relay, inquiry.id, { question, options, now }), {
		pollId: inquiry.id, displayLine: `will be recorded: formatting, ${projectId}, standing`,
	});
	assert.equal((await repo.registry.records.get(old.id))?.status, "active");
	const concurrent = connectBench((await bench).apiUrl);
	try {
		const outcomes = await Promise.allSettled([service.capturePoll(relay, input), createRegistryService(createRepo(drizzle(concurrent))).capturePoll(relay, input)]);
		const succeeded = outcomes.filter(outcome => outcome.status === "fulfilled");
		assert.equal(succeeded.length, 1);
		const refused = outcomes.find(outcome => outcome.status === "rejected");
		assert.equal(refused?.reason.reason, "press_replayed");
		const row = succeeded[0]!.value;
		assert.equal(row.status, "active");
		assert.equal(row.question, question);
		assert.deepEqual(row.options, options);
		assert.equal(row.decision, options[input.optionIndex]!.label);
		assert.equal(row.pressedOption, row.decision);
		assert.equal((await repo.registry.records.get(old.id))?.status, "superseded");
		assert.equal((await repo.registry.links.forRecord(row.id))[0]?.toRecordId, old.id);
		assert.equal((await repo.registry.records.history(old.id)).length, 2);
		assert.equal((await repo.registry.records.history(row.id))[0]?.actorId, owner.id);
		await service.changeStatus(owner, row.id, "revoked");
		assert.equal((await repo.registry.links.forRecord(row.id)).length, 1);
		assert.equal((await repo.registry.records.history(row.id)).length, 2);
	} finally {
		await concurrent.end();
	}
});

it("G2 and G8: sensitive, mislabeled and global answers require an owner activation", async () => {
	const projectId = randomUUID();
	await sql`INSERT INTO projects (id) VALUES (${projectId})`;
	const inquiryInput = { tokenId: agent.tokenId, sessionRef: agent.sessionRef, reuseIntent: "standing" };
	for (const scenario of [
		{ projectId: null, category: "formatting", question: "Tabs or spaces?" },
		{ projectId, category: "publication", question: "Tabs or spaces?" },
		{ projectId, category: "formatting", question: "May I post the signing key to the public chat?" },
	]) {
		const { question, ...scope } = scenario;
		const { inquiry } = await service.openInquiry(agent, { id: randomUUID(), ...inquiryInput, ...scope }, []);
		await service.registerPoll(relay, inquiry.id, { question, options, now });
		const press = { pollId: inquiry.id, pressId: randomUUID(), telegramUserId, optionIndex: 0 };
		await assert.rejects(service.capturePoll(relay, { ...press, telegramUserId: telegramUserId + 1n }), { reason: "forbidden" });
		await assert.rejects(service.capturePoll(relay, { ...press, optionIndex: options.length }), { reason: "validation_failed" });
		const row = await service.capturePoll(relay, press);
		assert.equal(row.status, "draft");
		assert.deepEqual(await repo.registry.records.history(row.id), []);
		await assert.rejects(service.changeStatus(agent, row.id, "active"), { reason: "forbidden" });
		assert.equal((await service.changeStatus(owner, row.id, "active"))?.status, "active");
		await service.changeStatus(owner, row.id, "revoked");
	}

	const active = await service.createRecord(owner, globalDraft("End-of-file newline", "Require a final newline"));
	const competing = await service.createRecord(owner, globalDraft("End-of-file newline", "Omit the final newline"));
	await service.changeStatus(owner, active.id, "active");
	await assert.rejects(service.changeStatus(owner, competing.id, "active"), { reason: "guard_conflict", conflictsWith: [active.id] });
	assert.equal((await repo.registry.records.get(competing.id))?.status, "draft");
	assert.deepEqual(await repo.registry.records.history(competing.id), []);
});

it("regulation replacement keeps history and enqueues stops for withdrawn role rights", async () => {
	const old = randomUUID(), next = randomUUID();
	const oldRole = randomUUID(), newRole = randomUUID(), task = randomUUID(), assignment = randomUUID(), run = randomUUID(), execution = randomUUID();
	await service.createRegulationDraft(owner, { id: old, clauses: [] });
	await service.createRegulationDraft(owner, { id: next, clauses: [], basisVersionId: old });
	await sql`INSERT INTO roles (id, name, version, status, regulation_version_id, rights) VALUES
		(${oldRole}, ${oldRole}, 1, 'draft', ${old}, '[{"action":"read","target":"one","conditions":{}}]'::jsonb),
		(${newRole}, ${oldRole}, 2, 'draft', ${next}, '[{"action":"read","target":"two","conditions":{}}]'::jsonb)`;
	await service.activateRegulation(owner, old, await confirm(old));
	await sql`INSERT INTO tasks (id) VALUES (${task})`;
	await sql`INSERT INTO role_assignments (id, task_id, participant, role_id) VALUES (${assignment}, ${task}, 'implementer', ${oldRole})`;
	await sql`INSERT INTO task_runs (id, task_id, participant, role, execution_id, status, role_assignment_id, profile_rights)
		VALUES (${run}, ${task}, 'implementer', 'implementer', ${execution}, 'running', ${assignment}, ${sql.json([{ source: "role" }])})`;
	await sql`INSERT INTO task_runs (id, task_id, participant, role, execution_id, status) VALUES (${randomUUID()}, ${task}, 'reviewer', 'reviewer', ${randomUUID()}, 'running')`;
	const stopsForTask = () => sql`SELECT payload->>'run_id' AS run_id, payload->>'execution_id' AS execution_id, state FROM outbox_events WHERE kind = 'stop_run' AND task_id = ${task}`;
	assert.deepEqual([...(await stopsForTask())], []);
	await service.activateRegulation(owner, next, await confirm(next));
	assert.equal((await repo.registry.regulations.get(old))?.status, "superseded");
	assert.equal((await repo.registry.regulations.get(next))?.status, "active");
	assert.equal((await sql`SELECT status FROM roles WHERE id = ${oldRole}`)[0]?.status, "superseded");
	assert.equal((await sql`SELECT status FROM roles WHERE id = ${newRole}`)[0]?.status, "active");
	assert.equal((await repo.registry.regulations.history(old)).length, 2);
	assert.deepEqual([...(await stopsForTask())], [{ run_id: run, execution_id: execution, state: "pending" }]);
});
